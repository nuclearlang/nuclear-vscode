// nuclear-loop: the Loop engine (loopEngine.ts) from a terminal or a CI job, without VS Code (ADR-0102).
//
//   nuclear-loop run [specs/<id>/spec.md] [--lead local|claude] the whole pipeline (no file: the newest spec)
//   nuclear-loop retry <run> [--from <stage>]                  a failed run again from the step that failed
//   nuclear-loop ci [stage...]                                   the deterministic stages of .nuclear/loop.json
//   nuclear-loop export github|gitlab|bitbucket                  writes the CI file of .nuclear/loop.json
//   nuclear-loop runs                                            the runs of this project
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CI_STAGES, CiProvider, LoopEngine, Run, StageId, ciCommands, ciFile, listRuns, newRun, parseSpecMarkdown, readConfig, toolEnv } from './loopEngine';
import { orphaned } from './loopSafety';

const USAGE = `nuclear-loop — the Nuclear Loop without the editor

  nuclear-loop run [spec.md] [--lead local|claude]   spec → generate → plan → tests → code → verify → security →
                                                     artifacts → deploy
                                                     (no file: the spec of specs/ changed last)
  nuclear-loop retry <run> [--from <stage>]          a failed run again from the step that failed (the steps that
                                                     passed are kept); --from restarts that whole stage;
                                                     calls to the local agents already retry by themselves with
                                                     exponential backoff (.nuclear/loop.json "retry")
  nuclear-loop ci [check|test|security|artifacts|deploy ...]   the commands of .nuclear/loop.json (all by default)
  nuclear-loop export github|gitlab|bitbucket        writes the CI file that runs \`nuclear-loop ci\`
  nuclear-loop runs                                  the runs kept in .nuclear/loop/runs

Run it in the project or any folder inside it (the project is the closest folder up with config.nuc). The agent stages need the Nuclear Developer
(127.0.0.1:7879) and, when Claude leads, Claude Code with the Nuclear MCP server.`;

interface Card {
  name: string;
  platform: string | null;
  dialect: string;
}

/** The project card `nuclear check` writes (.nuclear/project.json); written now when it is missing. */
async function card(root: string): Promise<Card> {
  const file = path.join(root, '.nuclear', 'project.json');
  if (!fs.existsSync(file)) await sh('nuclear check . > /dev/null', root, true);
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Card>;
    return { name: c.name ?? path.basename(root), platform: c.platform ?? null, dialect: c.dialect ?? '' };
  } catch {
    throw new Error(`${root} is not a Nuclear project (no config.nuc, or nuclear is not on the PATH)`);
  }
}

function sh(command: string, cwd: string, quiet = false): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(command, { cwd, shell: true, stdio: quiet ? 'ignore' : 'inherit', env: toolEnv() });
    p.on('close', (code) => resolve(code ?? 1));
    p.on('error', () => resolve(127));
  });
}

async function ci(root: string, only: string[]): Promise<number> {
  const unknown = only.filter((s) => !(CI_STAGES as readonly string[]).includes(s));
  if (unknown.length) {
    console.error(`unknown stage: ${unknown.join(', ')} (stages: ${CI_STAGES.join(', ')})`);
    return 2;
  }
  const { platform } = await card(root);
  const commands = ciCommands(readConfig(root, platform ?? '').commands);
  for (const stage of CI_STAGES) {
    if (only.length && !only.includes(stage)) continue;
    for (const command of commands[stage]) {
      console.log(`\n▶ ${stage}: ${command}`);
      const code = await sh(command, root);
      if (code !== 0) {
        console.error(`✗ ${stage}: ${command} exited ${code}`);
        return code;
      }
    }
    if (commands[stage].length) console.log(`✓ ${stage}`);
  }
  return 0;
}

const MARK: Record<string, string> = { passed: '✓', failed: '✗', skipped: '·', running: '▶', pending: ' ' };

async function run(root: string, specFile: string, lead?: string): Promise<number> {
  const text = fs.readFileSync(path.resolve(process.cwd(), specFile), 'utf8');
  const id = path.basename(path.dirname(path.resolve(process.cwd(), specFile)));
  const spec = parseSpecMarkdown(text, id);
  if (lead === 'local' || lead === 'claude') spec.lead = lead;
  const c = await card(root);
  return drive(new LoopEngine(newRun(root, c, spec), readConfig(root, c.platform ?? '')));
}

async function retry(root: string, id: string, from?: string): Promise<number> {
  const old = listRuns(root).find((r) => r.id === id);
  if (!old) {
    console.error(`no run '${id}' (nuclear-loop runs)`);
    return 2;
  }
  if (from && !old.stages.some((s) => s.id === from)) {
    console.error(`unknown stage '${from}' (${old.stages.map((s) => s.id).join(', ')})`);
    return 2;
  }
  return drive(new LoopEngine(old, readConfig(root, old.platform)), from as StageId | undefined, !from);
}

/** One line per step when it ends; the run itself is kept in .nuclear/loop/runs/<id>.json and its journal <id>.md. */
async function drive(engine: LoopEngine, from?: StageId, step = false): Promise<number> {
  const shown = new Set<string>();
  engine.on('change', (r: Run) => {
    for (const stage of r.stages) {
      for (const s of stage.steps) {
        if (s.status === 'running' || s.status === 'pending' || shown.has(s.id)) continue;
        shown.add(s.id);
        console.log(`${MARK[s.status]} ${stage.title} · ${s.actor} · ${s.title}${s.summary ? ` — ${s.summary}` : ''}`);
      }
    }
  });
  process.on('SIGINT', () => engine.stop());
  const done = await engine.start(from, step);
  if (done.diagnosis) console.log(`\nWhy it failed (local diagnoser):\n${done.diagnosis}\n\nRetry: nuclear-loop retry ${done.id}`);
  console.log(`\n${MARK[done.status]} ${done.status}${done.costUsd ? ` · Claude USD ${done.costUsd.toFixed(2)}` : ''} · .nuclear/loop/runs/${done.id}.md`);
  return done.status === 'passed' ? 0 : 1;
}

/** The closest folder up from `dir` with a config.nuc (the project), or `dir`. */
function projectRoot(dir: string): string {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'config.nuc'))) return d;
    if (path.dirname(d) === d) return path.resolve(dir);
  }
}

/** specs/<id>/spec.md changed last. */
function newestSpec(root: string): string | undefined {
  const dir = path.join(root, 'specs');
  if (!fs.existsSync(dir)) return undefined;
  return fs
    .readdirSync(dir)
    .map((id) => path.join(dir, id, 'spec.md'))
    .filter((f) => fs.existsSync(f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}

async function main(argv: string[]): Promise<number> {
  const root = projectRoot(process.cwd());
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'run': {
      const lead = rest[rest.indexOf('--lead') + 1];
      const file = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--lead') ?? newestSpec(root);
      if (!file) {
        console.error('no spec: write specs/<id>/spec.md (the Loop panel or by hand) or pass its path');
        return 2;
      }
      return run(root, file, rest.includes('--lead') ? lead : undefined);
    }
    case 'retry': {
      const id = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--from');
      if (!id) break;
      return retry(root, id, rest.includes('--from') ? rest[rest.indexOf('--from') + 1] : undefined);
    }
    case 'ci':
      return ci(root, rest);
    case 'export': {
      const provider = rest[0] as CiProvider;
      if (!['github', 'gitlab', 'bitbucket'].includes(provider)) break;
      const { platform } = await card(root);
      const out = ciFile(provider, readConfig(root, platform ?? ''), platform ?? '');
      fs.mkdirSync(path.dirname(path.join(root, out.path)), { recursive: true });
      fs.writeFileSync(path.join(root, out.path), out.text);
      console.log(`wrote ${out.path}`);
      return 0;
    }
    case 'runs':
      for (const r of listRuns(root)) {
        const lost = r.status === 'running' && orphaned(r.owner);
        console.log(`${lost ? '⚠' : MARK[r.status]} ${r.id}  ${r.spec.title}  ${new Date(r.created).toISOString().slice(0, 16)}${lost ? '  interrupted: nuclear-loop retry ' + r.id + ' goes on where it stopped' : ''}`);
      }
      return 0;
  }
  console.log(USAGE);
  return cmd && !['help', '--help', '-h'].includes(cmd) ? 2 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`nuclear-loop: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
