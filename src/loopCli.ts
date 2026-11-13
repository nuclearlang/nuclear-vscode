// nuclear-loop: the Loop engine (loopEngine.ts) from a terminal or a CI job, without VS Code (ADR-0102).
//
//   nuclear-loop run [specs/<id>/spec.md] [--lead local|claude] the whole pipeline (no file: the newest spec)
//   nuclear-loop retry <run> [--from <stage> | --step <id>]    a run again from the step that failed, a whole stage,
//                                                                or any step of it (passed or failed)
//   nuclear-loop restart <run>                                   the whole pipeline again from scratch
//   nuclear-loop ci [stage...]                                   the deterministic stages of .nuclear/loop.json
//   nuclear-loop export github|gitlab|bitbucket                  writes the CI file of .nuclear/loop.json
//   nuclear-loop runs                                            the runs of this project
//   nuclear-loop setup [--profile <id>] [--yes] | --status | --remove   the AI services of this machine (ADR-0106)
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { PROFILES, aiRoot, fit, hardware, machineFile, profileOf, recommend, remove, requirements, status, steps } from './aiSetup';
import { CI_STAGES, CiProvider, LoopEngine, Run, StageId, ciCommands, ciFile, listRuns, newRun, parseSpecMarkdown, readConfig, toolEnv } from './loopEngine';
import { orphaned } from './loopSafety';

const USAGE = `nuclear-loop — the Nuclear Loop without the editor

  nuclear-loop run [spec.md] [--lead local|claude]   spec → generate → plan → tests → code → verify → security →
                                                     artifacts → deploy
                                                     (no file: the spec of specs/ changed last)
  nuclear-loop retry <run> [--from <stage> | --step <id>]
                                                     a run again from the step that failed (the steps that passed are
                                                     kept); --from runs that whole stage again; --step runs that step
                                                     (\`code-3\`: passed or failed) and every step after it. What the
                                                     steps left out wrote is undone first. Calls to the local agents
                                                     already retry by themselves (.nuclear/loop.json "retry")
  nuclear-loop restart <run>                         the whole pipeline again from the specification: every file the
                                                     run wrote goes back to what it was, then every stage runs
  nuclear-loop ci [check|test|security|artifacts|deploy ...]   the commands of .nuclear/loop.json (all by default)
  nuclear-loop export github|gitlab|bitbucket        writes the CI file that runs \`nuclear-loop ci\`
  nuclear-loop runs                                  the runs kept in .nuclear/loop/runs
  nuclear-loop setup [--profile remote|lite|medium|hard] [--yes] | --status | --remove
                                                     the AI services of this machine, step by step: it reads the
                                                     hardware, suggests a profile (which models are downloaded and how
                                                     far each works), installs what is missing (uv, Ollama), the
                                                     Smart Graph and the Nuclear Developer, downloads the models, loads
                                                     the knowledge base and starts the services, now and at every login
                                                     (--yes: no questions, the suggested profile; --status: what is
                                                     installed and running; --remove: takes the services away, Ollama
                                                     and its models stay)

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

async function ask(question: string, fallback: string): Promise<string> {
  if (!process.stdin.isTTY) return fallback;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim() || fallback;
}

/** The AI services of this machine, in a terminal: the same steps as the editor's set-up (aiSetup.ts). */
async function setup(args: string[]): Promise<number> {
  if (args.includes('--remove')) {
    await remove(console.log);
    console.log("The AI services are removed. Ollama, its models and the graph's data stay.");
    return 0;
  }
  if (args.includes('--status')) {
    const st = await status();
    const on = (ok: boolean) => (ok ? 'running' : 'not running');
    console.log(st.machine.NUCLEAR_AI_MODE ? `profile ${st.machine.NUCLEAR_AI_PROFILE} (${machineFile()})` : 'not set up: nuclear-loop setup');
    if (st.machine.NUCLEAR_AI_MODE !== 'local') return st.machine.NUCLEAR_AI_MODE ? 0 : 1;
    console.log(`Smart Graph        ${on(st.graph)}\nNuclear Developer  ${on(st.developer)}\nOllama             ${on(st.ollama)}`);
    console.log(`models             ${st.missingModels.length ? 'missing ' + st.missingModels.join(', ') : 'installed'}\nat login           ${st.atLogin ? 'yes' : 'no'}`);
    return st.graph && st.developer && st.ollama && !st.missingModels.length ? 0 : 1;
  }
  const yes = args.includes('--yes');
  const hw = await hardware();
  const suggested = recommend(hw);
  console.log(`This machine: ${hw.cpu}, ${hw.cores} threads, ${hw.ram} GB of memory, ${hw.gpu || 'no GPU with memory of its own'}, ${hw.disk} GB of disk free.\n`);
  for (const p of PROFILES) {
    const f = fit(p, hw);
    console.log(`${p.id === suggested ? '→' : ' '} ${p.id.padEnd(7)} ${p.title}: downloads ${p.gb} GB${p.id === suggested ? '   (suggested for this machine)' : ''}`);
    console.log(`          ${p.summary}`);
    if (p.coder) console.log(`          ${f.fit === 'no' ? '✗ not for this machine' : f.fit === 'tight' ? '! tight on this machine' : 'on this machine'}: ${f.note}`);
    if (p.coder) console.log(`          measured: ${p.measured}`);
    for (const w of p.works) console.log(`          ✓ ${w}`);
    for (const l of p.limits) console.log(`          ✗ ${l}`);
    console.log('');
  }
  const given = args.includes('--profile') ? args[args.indexOf('--profile') + 1] : undefined;
  const p = profileOf(given ?? (yes ? suggested : await ask(`Which one? ${PROFILES.map((x) => x.id).join(', ')} [${suggested}]: `, suggested)));
  if (!p) {
    console.error(`no such profile: ${PROFILES.map((x) => x.id).join(', ')}`);
    return 2;
  }
  const f = fit(p, hw);
  if (f.fit === 'no' && !/^y/i.test(yes ? 'y' : await ask(`${p.title} is not for this machine (${f.note}). Install it anyway? [y/N]: `, 'n'))) return 1;

  // what it needs, found or installed by its own installer, one at a time
  for (;;) {
    const missing = (await requirements(!!p.coder)).find((r) => !r.found);
    if (!missing) break;
    const command = missing.install[process.platform];
    console.log(`\n${missing.title} is needed (${missing.why}): ${missing.detail}.`);
    const by = `Install it from ${missing.url} and run \`nuclear-loop setup\` again${missing.local ? ', or choose the profile `remote`' : ''}.`;
    if (!command || missing.detail.startsWith('installed, not running')) {
      console.log(command ? 'Start it and run `nuclear-loop setup` again.' : by);
      return 1;
    }
    if (missing.note?.[process.platform]) console.log(missing.note[process.platform]);
    if (!/^y/i.test(yes ? 'y' : await ask(`Install it now with \`${command}\`? [Y/n]: `, 'y'))) {
      console.log(by);
      return 1;
    }
    await sh(command, process.cwd());
    let found = false;
    for (let i = 0; i < 20 && !found; i++) {
      found = (await requirements(!!p.coder)).find((r) => r.id === missing.id)?.found ?? false;
      if (!found) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!found) {
      console.log(`${missing.title} is still not found. ${by}`);
      return 1;
    }
  }

  const all = steps(p, aiRoot()!);
  for (const [i, step] of all.entries()) {
    console.log(`\n[${i + 1}/${all.length}] ${step.title}`);
    await step.run((line) => console.log(`    ${line}`));
  }
  console.log(p.coder
    ? `\nDone: the Smart Graph (127.0.0.1:7878) and the Nuclear Developer (127.0.0.1:7879) run with the profile ${p.id}, now and at every login.\nYour agents: nuclear-graph mcp (claude mcp add --scope user nuclear -- nuclear-graph mcp). State: nuclear-loop setup --status`
    : '\nDone: add the MCP server to your agent (claude mcp add --scope user nuclear -- nuclear-graph mcp). The local agents: nuclear-loop setup again, another profile.');
  return 0;
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

/** `step`: a step's id (that step and all after it), `true` the step that failed, `false` the whole stage `from`;
 * `scratch`: the whole pipeline. */
async function retry(root: string, id: string, from?: string, step?: string, scratch = false): Promise<number> {
  const old = listRuns(root).find((r) => r.id === id);
  if (!old) {
    console.error(`no run '${id}' (nuclear-loop runs)`);
    return 2;
  }
  if (from && !old.stages.some((s) => s.id === from)) {
    console.error(`unknown stage '${from}' (${old.stages.map((s) => s.id).join(', ')})`);
    return 2;
  }
  if (step && !old.stages.some((s) => s.steps.some((x) => x.id === step))) {
    console.error(`unknown step '${step}' (${old.stages.flatMap((s) => s.steps.map((x) => x.id)).join(', ')})`);
    return 2;
  }
  const engine = new LoopEngine(old, readConfig(root, old.platform));
  return drive(engine, () => (scratch ? engine.restart() : engine.start(from as StageId | undefined, step ?? !from)));
}

/** One line per step when it ends; the run itself is kept in .nuclear/loop/runs/<id>.json and its journal <id>.md. */
async function drive(engine: LoopEngine, go: () => Promise<Run> = () => engine.start()): Promise<number> {
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
  const done = await go();
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
    case 'retry':
    case 'restart': {
      const id = rest.find((a, i) => !a.startsWith('--') && rest[i - 1] !== '--from' && rest[i - 1] !== '--step');
      if (!id) break;
      const flag = (name: string) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : undefined);
      return retry(root, id, flag('--from'), flag('--step'), cmd === 'restart');
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
    case 'setup':
      return setup(rest);
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
