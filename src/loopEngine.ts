// The Nuclear Loop engine (ADR-0102): a spec goes through the pipeline spec → plan → code → test → security →
// artifacts → deploy on the developer's machine, and every step says who does it (you, Claude, a local agent, the
// shell) and what it did. A frontier model (Claude) plans and reviews; the local developer (Nuclear Developer, a 3B
// model fed by the Nuclear Smart Graph) writes each piece; the shell runs the project's own commands, the same ones the
// exported CI runs on a server. No VS Code here: the panel (loopPanel.ts) draws what this module emits, and a node
// script can drive it alone.
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readMachine } from './aiSetup';
import { atomicWrite, BEAT_MS, checkConnections, digest, ollamaBusy, orphaned, owner, Owner, rollback, trace, Write } from './loopSafety';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type Status = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
/** Who does a step. */
export type Actor = 'you' | 'claude' | 'planner' | 'coder' | 'tester' | 'security' | 'diagnoser' | 'shell' | 'graph';
export type StageId = 'spec' | 'generate' | 'plan' | 'test' | 'code' | 'verify' | 'security' | 'artifacts' | 'deploy';
export type UseCase = 'feature' | 'refactor' | 'bug' | 'docs' | 'diagram' | 'test' | 'security';

export interface TraceItem {
  step: string;
  detail: string;
}

/** A choice made while a step ran and the reason for it: which strategy, which file is repaired, why a stage is left
 * out. What the graph of a run shows when its node is opened. */
export interface Decision {
  what: string;
  why: string;
}

export interface Step {
  id: string;
  title: string;
  actor: Actor;
  status: Status;
  started?: number;
  ended?: number;
  /** One line: what came out. */
  summary: string;
  /** The output of a command, the text of a model, the findings of a review. */
  log: string;
  /** What a local agent did, step by step (recall, write, repair...). */
  trace: TraceItem[];
  /** The choices the step made, each with its reason. */
  decisions?: Decision[];
  /** The file a piece wrote and its code. */
  file?: string;
  /** The files a generator wrote or changed (the Generate stage). */
  files?: string[];
  code?: string;
  /** What a local agent read instead of `log` (a failing test told in Nuclear by `dragonfly explain`): the raw log is
   * kept as it is. */
  agent?: string;
  /** The tool a frontier model called (`developer_code`, `nuclear_check`...) and its input. */
  tool?: string;
  input?: string;
}

export interface Stage {
  id: StageId;
  title: string;
  /** What this stage is for, and which actors take part (shown before it runs). */
  about: string;
  actors: Actor[];
  status: Status;
  started?: number;
  ended?: number;
  steps: Step[];
}

export interface Piece {
  path: string;
  kind: string;
  task: string;
  /** The whole file, when a tool already wrote it (a rename): it is written as it is and no agent is asked. */
  code?: string;
  /** Who gave the piece: `you` (written in the form: kept when the plan is made again), else a planner or the
   * analysis (made again with the plan). */
  by?: 'you' | 'planner' | 'claude' | 'analysis';
}

/** What the local analyst says of a spec before the run does anything (ADR-0105): which kind of request it is (its
 * strategy, a row of the graph) and what that asks of the run. */
export interface Analysis {
  strategy: string;
  title: string;
  /** The signs of the request that chose the strategy. */
  why: string;
  /** write, repair, verify, review, answer, commands or lead */
  mode: string;
  /** The stages that run after the specification. Empty: this kind of request is not a run of the Loop. */
  stages: string[];
  lead: string;
  /** Where the pieces come from: plan (the planner splits what is left), declaring, naming or none. */
  source: string;
  /** Arguments of `dragonfly gen`, each one accepted by its dry run. */
  generate: string[][];
  /** The pieces the tools already gave: the files that declare what changes, or the files of a rename. */
  pieces: Piece[];
  /** The facts the strategy cannot start without and the request does not give. */
  questions: string[];
  limits: string[];
  report: string;
}

export interface Spec {
  id: string;
  title: string;
  useCase: UseCase;
  description: string;
  criteria: string[];
  /** Files given to the agents as context (AGENTS.md, specs, skills...), relative to the project or absolute. */
  context: string[];
  source: { kind: 'local' | 'jira' | 'github'; key?: string; url?: string };
  /** `claude`: Claude plans and reviews, the local developer writes; `local`: only the local agents. */
  lead: 'claude' | 'local';
  /** Pieces written by hand in the form (the plan stage fills them otherwise). */
  pieces: Piece[];
  /** What `dragonfly gen resource` generates before the plan: one line of its arguments each (`characters Character
   * --screen characters`). Empty: each `GET <url>` line of the description is a resource. */
  resources?: string[];
  /** The strategy the spec names itself (`usecase`, `bug-compile`...): the analysis then does not choose. */
  strategy?: string;
}

export interface Run {
  id: string;
  root: string;
  project: string;
  platform: string;
  dialect: string;
  spec: Spec;
  status: Status;
  created: number;
  ended?: number;
  stages: Stage[];
  costUsd: number;
  /** What the local documenter wrote about the run (`/developer/document`), at the top of the journal. */
  notes?: string;
  /** Which kind of request the spec is and what its strategy asks of the run (`/developer/analyze`). */
  analysis?: Analysis;
  /** Why the run failed, told by the local diagnoser (`/developer/diagnose`): kind, action and explanation. */
  diagnosis?: string;
  /** The earlier attempts of a run retried from a stage: their stages as they ended, and what was asked (`why`: from
   * scratch, from a step, the whole stage) with the files that retry undid. */
  previous?: { at: number; from: StageId; status: Status; stages: Stage[]; why?: string; undone?: string[] }[];
  /** The version of the engine that made the run (`ENGINE`). A run of an older one lacks what was added since (a
   * stage, the analysis): it is run again from the specification, never from its middle. */
  engine?: number;
  /** Each acceptance criterion at the end of the run: whether the result shows it met, and where. */
  acceptance?: { criterion: string; met: boolean; evidence: string }[];
  /** The process running it and its last heartbeat (loopSafety.ts): a stale beat means the run was orphaned. */
  owner?: Owner;
  /** Every project file the run wrote, with what was there before: what a broken step wrote is undone. */
  writes?: Write[];
  /** When the run was found orphaned: where it stopped and the files undone, before it went on. */
  interrupted?: { at: number; stage: string; step: string; undone: string[] }[];
}

/** `.nuclear/loop.json`: the commands of each stage (the ones CI runs too) and where the agents answer. */
export interface LoopConfig {
  developerUrl: string;
  graphCommand: string;
  claudeModel: string;
  commands: Record<'check' | 'build' | 'test' | 'security' | 'artifacts' | 'seed' | 'integration' | 'deploy', string[]>;
  /** The branches whose pushes run the exported pipeline. */
  branches: string[];
  /** Automatic retries of a call to the local agents that failed for a passing reason (see `backoff`). */
  retry: RetryPolicy;
  /** The services the preflight checks and the stall probe watches. */
  graphUrl: string;
  ollamaUrl: string;
  coderModel: string;
  assistantModel: string;
  /** A call to the local agents that takes longer is cut (and retried): ms. */
  callTimeoutMs: number;
  /** A call is stalled when, for this long, the Developer does not answer or Ollama holds no model: seconds. */
  stallSeconds: number;
  /** Free space the project and the temporary folder need before a run starts: MB. */
  minFreeMb: number;
  /** Claude Code: its command, and the most a run may spend (USD, 0 = no limit). */
  claudeCommand: string;
  claudeBudgetUsd: number;
  /** Check the services before a run (off only in tests with fake services). */
  preflight: boolean;
  /** A command of the pipeline that runs longer is killed with its children (a hanging test): ms, 0 = no limit. */
  commandTimeoutMs: number;
}

export interface RetryPolicy {
  /** Tries in all, the first included. */
  attempts: number;
  /** The first wait's ceiling, in milliseconds; each retry doubles it. */
  baseMs: number;
  /** The longest wait, in milliseconds. */
  maxMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { attempts: 5, baseMs: 1000, maxMs: 30000 };

/** The wait before retry `n` (1 for the first retry): exponential backoff with full jitter, a random time between 0
 * and min(maxMs, baseMs·2^(n-1)). The jitter keeps many clients from retrying in step; the cap keeps a long outage
 * from making waits absurd. A `Retry-After` the server gives wins (capped the same). */
export function backoff(n: number, policy: RetryPolicy, retryAfterMs?: number, random: () => number = Math.random): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.max(0, n - 1));
  return retryAfterMs !== undefined ? Math.min(policy.maxMs, retryAfterMs) : Math.round(random() * ceiling);
}

/** A status worth retrying: the server is busy or briefly down (408, 425, 429, 500, 502, 503, 504). A 4xx otherwise
 * is the request's fault and fails again the same way. */
export function transientStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

/** `Retry-After` in milliseconds (seconds or an HTTP date), or undefined. */
export function retryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export const CONFIG_FILE = path.join('.nuclear', 'loop.json');
export const RUNS_DIR = path.join('.nuclear', 'loop', 'runs');
export const ARTIFACTS_DIR = path.join('.nuclear', 'loop', 'artifacts');
export const SPECS_DIR = 'specs';

/** Raised when a stage, or what a run must do before it retries, changes: an older run starts again from scratch. */
export const ENGINE = 2;

const STAGES: Omit<Stage, 'status' | 'steps'>[] = [
  { id: 'spec', title: 'Specification', about: 'The spec you wrote or imported, with its acceptance criteria and the context the agents get, written to specs/<id>/spec.md. Then its analysis: which kind of request it is (a whole system, one screen, a rename, a failing test...) and the strategy the run follows: the stages that run, what the generators write, the facts it lacks.', actors: ['you', 'planner'] },
  { id: 'generate', title: 'Generate', about: 'dragonfly gen writes what follows from the data, already compiling: for each resource of the spec (its GET <url> lines, or its Resources) the models, the repository, a use case per action, the facade, the controller or the screen, the tests. The agents write only what is left.', actors: ['shell'] },
  { id: 'plan', title: 'Plan', about: 'The work split into pieces of one file each, in the order they can be written. Claude plans when it leads; otherwise the local planner (gemma4:e2b) does.', actors: ['claude', 'planner', 'graph'] },
  { id: 'test', title: 'Tests first', about: 'Before any code, the local tester writes the tests from the acceptance criteria, the planned pieces and the project map (.nuclear/map.md): what the code must do, in Nuclear.', actors: ['tester', 'graph'] },
  { id: 'code', title: 'Code', about: 'The local coder (qwen2.5-coder:3b) writes each piece with the Smart Graph and repairs it with the compiler; Claude only fixes what it could not. Ends with nuclear check of the whole project, the tests included.', actors: ['coder', 'tester', 'graph', 'claude', 'shell'] },
  { id: 'verify', title: 'Verification', about: 'The project is built and every test runs. A failing test goes back to the coder told in Nuclear (dragonfly explain: the message, a hint and the .nuc lines), then the tests run again (at most 3 rounds); Claude takes what is left when it leads.', actors: ['shell', 'coder', 'tester', 'claude'] },
  { id: 'security', title: 'Security', about: 'The local reviewer reads each new file against the platform\'s security rules; the project\'s security commands run.', actors: ['security', 'shell'] },
  { id: 'artifacts', title: 'Artifacts', about: 'The project is built and its output kept with the run (generated code, contract, OpenAPI).', actors: ['shell'] },
  { id: 'deploy', title: 'Deploy', about: 'Seeds, integration tests and the local deploy of .nuclear/loop.json; the same commands the exported CI runs on a server.', actors: ['shell'] },
];

/** The default pipeline of a platform: the commands the platform's CLI already has. */
export function defaultConfig(platform: string): LoopConfig {
  const mobile = platform === 'mobile';
  return {
    developerUrl: 'http://127.0.0.1:7879',
    graphCommand: 'nuclear-graph',
    claudeModel: 'sonnet',
    commands: {
      check: ['nuclear check . --json'],
      build: mobile ? ['dragonfly build'] : ['dragonfly build', 'dragonfly install'],
      test: ['dragonfly test'],
      security: [],
      artifacts: mobile ? ['dragonfly build web'] : ['dragonfly build'],
      seed: [],
      integration: mobile ? [] : [],
      deploy: [],
    },
    branches: ['main', 'feature/**'],
    retry: { ...DEFAULT_RETRY },
    graphUrl: 'http://127.0.0.1:7878',
    ollamaUrl: 'http://localhost:11434',
    // the models of the profile this machine was set up with (ADR-0106), else the heaviest profile's
    coderModel: readMachine().CODER_MODEL ?? 'qwen2.5-coder:3b',
    assistantModel: readMachine().ASSISTANT_MODEL ?? 'gemma4:e2b',
    callTimeoutMs: 15 * 60_000,
    stallSeconds: 90,
    minFreeMb: 500,
    claudeCommand: 'claude',
    claudeBudgetUsd: 2,
    preflight: true,
    commandTimeoutMs: 20 * 60_000,
  };
}

/** The pipeline of a project: the defaults, under them the machine's settings (`machine`: the editor's
 * `nuclear.ai.*`), and over both the project's `.nuclear/loop.json` (shared with CI). */
export function readConfig(root: string, platform: string, machine: Partial<LoopConfig> = {}): LoopConfig {
  const defaults = defaultConfig(platform);
  const base: LoopConfig = { ...defaults, ...machine, commands: defaults.commands, retry: { ...defaults.retry, ...(machine.retry ?? {}) } };
  try {
    const own = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8')) as Partial<LoopConfig>;
    return { ...base, ...own, commands: { ...base.commands, ...(own.commands ?? {}) }, retry: { ...base.retry, ...(own.retry ?? {}) } };
  } catch {
    return base;
  }
}

export function writeConfig(root: string, config: LoopConfig): void {
  fs.mkdirSync(path.join(root, '.nuclear'), { recursive: true });
  fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify(config, null, 2) + '\n');
}

export function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'spec';
}

export function newRun(root: string, card: { name: string; platform: string | null; dialect: string }, spec: Spec): Run {
  return {
    id: spec.id,
    root,
    project: card.name,
    platform: card.platform ?? '',
    dialect: card.dialect,
    // the pieces a spec brings were written by the user (the form, or the Pieces of its file)
    spec: { ...spec, pieces: spec.pieces.map((p) => ({ ...p, by: p.by ?? 'you' })) },
    status: 'pending',
    created: Date.now(),
    stages: STAGES.map((s) => ({ ...s, status: 'pending', steps: [] })),
    costUsd: 0,
    engine: ENGINE,
  };
}

/** A run as this engine reads it, whatever version wrote it: every stage of today in its place (one a newer engine
 * added was never run: skipped), and each piece with who gave it (before `by`, a piece is the user's only when no
 * planner ever made the plan). Changes nothing of a run this engine made. */
export function upgradeRun(run: Run): Run {
  if (run.engine === ENGINE) return run;
  const ran = run.status !== 'pending';
  run.stages = STAGES.map((s) => {
    const old = run.stages.find((x) => x.id === s.id);
    return old ? { ...old, title: s.title, about: s.about, actors: s.actors } : { ...s, status: ran ? 'skipped' : 'pending', steps: [] };
  });
  const plans = [run.stages, ...(run.previous ?? []).map((p) => p.stages)].flatMap((stages) => stages.find((st) => st.id === 'plan')?.steps ?? []);
  const planned = plans.some((s) => s.actor === 'planner' || s.actor === 'claude' || s.title === 'Pieces from the analysis');
  run.spec.pieces = run.spec.pieces.map((p) => ({ ...p, by: p.by ?? (planned ? 'planner' : 'you') }));
  if (!ran) run.engine = ENGINE;
  return run;
}

export function listRuns(root: string): Run[] {
  const dir = path.join(root, RUNS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return upgradeRun(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Run);
      } catch {
        return undefined;
      }
    })
    .filter((r): r is Run => !!r)
    .sort((a, b) => b.created - a.created);
}

/** The spec as markdown (specs/<id>/spec.md): what a reviewer, a CI job or another agent reads. */
export function specMarkdown(spec: Spec): string {
  const lines = [`# ${spec.title}`, '', `- Use case: ${spec.useCase}`, `- Source: ${spec.source.kind}${spec.source.key ? ` ${spec.source.key}` : ''}${spec.source.url ? ` (${spec.source.url})` : ''}`, `- Lead: ${spec.lead === 'claude' ? 'Claude plans and reviews; the local developer writes' : 'local agents only'}`, '', '## Description', '', spec.description.trim(), '', '## Acceptance criteria', ''];
  if (spec.strategy) lines.splice(3, 0, `- Strategy: ${spec.strategy}`);
  lines.push(...(spec.criteria.length ? spec.criteria.map((c) => `- [ ] ${c}`) : ['- (none yet)']));
  if (spec.context.length) lines.push('', '## Context', '', ...spec.context.map((c) => `- ${c}`));
  if (spec.resources?.length) lines.push('', '## Resources', '', ...spec.resources.map((r) => `- \`${r}\``));
  // only the pieces the user wrote: the ones a planner gave are made again with the plan
  const own = spec.pieces.filter((p) => !p.by || p.by === 'you');
  if (own.length) lines.push('', '## Pieces', '', ...own.map((p) => `- \`${p.path}\` (${p.kind}): ${p.task}`));
  return lines.join('\n') + '\n';
}

/** A spec back from its markdown (what `specMarkdown` writes, or one written by hand in that shape): the CLI and CI
 * run the spec file of the repository. */
export function parseSpecMarkdown(text: string, id: string): Spec {
  const title = (text.match(/^#\s+(.+)$/m)?.[1] ?? id).trim();
  const field = (name: string) => text.match(new RegExp(`^- ${name}:\\s*(.+)$`, 'm'))?.[1].trim() ?? '';
  const section = (name: string) => {
    const m = text.match(new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm'));
    return m ? m[1].trim() : '';
  };
  const items = (body: string) => body.split('\n').map((l) => l.match(/^\s*-\s+(?:\[[ x]\]\s+)?(.+)$/)?.[1].trim()).filter((l): l is string => !!l && l !== '(none yet)');
  const useCase = field('Use case') as UseCase;
  const pieces = items(section('Pieces')).flatMap((l) => {
    const m = l.match(/^`([^`]+\.nuc)`\s*\(([^)]*)\):\s*(.+)$/);
    return m ? [{ path: m[1], kind: m[2], task: m[3] }] : [];
  });
  const source = field('Source');
  const kind = source.startsWith('jira') ? 'jira' : source.startsWith('github') ? 'github' : 'local';
  return {
    id,
    title,
    useCase: ['feature', 'refactor', 'bug', 'docs', 'diagram', 'test', 'security'].includes(useCase) ? useCase : 'feature',
    description: section('Description'),
    criteria: items(section('Acceptance criteria')),
    context: items(section('Context')),
    source: { kind, key: source.split(/\s+/)[1], url: source.match(/\((https?:[^)]+)\)/)?.[1] },
    lead: field('Lead').startsWith('local') ? 'local' : 'claude',
    pieces,
    resources: items(section('Resources')).map((l) => l.replace(/^`|`$/g, '')),
    strategy: field('Strategy').replace(/^strategy:/, '') || undefined,
  };
}

/** The resources a spec names (`dragonfly gen resource` arguments): its Resources, else one per `GET <url>` line of
 * its description, named after the url's last segment (`/api/character` → `characters Character`); mobile and web
 * get a screen that lists it. */
export function specResources(spec: Spec, platform: string): string[] {
  if (spec.resources?.length) return spec.resources;
  const out: string[] = [];
  for (const m of spec.description.matchAll(/^\s*GET\s+(https?:\/\/\S+)\s*$/gm)) {
    const last = new URL(m[1]).pathname.split('/').filter(Boolean).pop();
    if (!last || !/^[a-z][a-z0-9_-]*$/i.test(last)) continue;
    const word = last.replace(/-/g, '_').toLowerCase();
    const one = word.endsWith('ies') ? word.slice(0, -3) + 'y' : word.endsWith('s') ? word.slice(0, -1) : word;
    const many = one.endsWith('y') ? one.slice(0, -1) + 'ies' : one.endsWith('s') ? one : one + 's';
    const name = one.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    const line = `${many} ${name}${platform === 'backend' ? '' : ` --screen ${many}`}`;
    if (!out.includes(line)) out.push(line);
  }
  return out;
}

/** Every `.nuc` of a project with its text (not the build output, nor `.nuclear/`): what a generator changed is the
 * difference. */
export function nucFiles(root: string, dir = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['build', 'node_modules', '.git', '.nuclear'].includes(e.name) || e.name.startsWith('.')) continue;
      for (const [k, v] of nucFiles(root, rel)) out.set(k, v);
    } else if (e.name.endsWith('.nuc')) out.set(rel, fs.readFileSync(path.join(root, rel), 'utf8'));
  }
  return out;
}

const clip = (text: string, lines: number) => {
  const all = text.trimEnd().split('\n');
  return all.length > lines ? [...all.slice(0, lines), `… (${all.length - lines} more lines in the run's .json)`].join('\n') : all.join('\n');
};

/** The journal of a run (`.nuclear/loop/runs/<id>.md`, rewritten on every change): everything the agents did, step by
 * step, for the person or the frontier model that reviews it. The `.json` next to it keeps every log whole. */
export function journalMarkdown(run: Run): string {
  const when = (t?: number) => (t ? new Date(t).toISOString().slice(0, 19).replace('T', ' ') : '—');
  const out = [
    `# Journal: ${run.spec.title}`,
    '',
    `- Run: ${run.id} · ${run.status} · ${when(run.created)} → ${when(run.ended)}`,
    `- Project: ${run.project} (${run.platform}${run.dialect ? ` · ${run.dialect}` : ''})`,
    `- Lead: ${run.spec.lead === 'claude' ? 'Claude plans and reviews; the local developer writes' : 'the local agents'}${run.costUsd ? ` · Claude USD ${run.costUsd.toFixed(2)}` : ''}`,
    `- Spec: specs/${run.spec.id}/spec.md · the lead's review, once there is one: ${RUNS_DIR}/${run.id}.review.md`,
    ...(run.analysis ? [`- Strategy: ${run.analysis.strategy.replace(/^strategy:/, '')} · ${run.analysis.title.replace(/^Strategy: /, '')}${run.analysis.why ? ` (${run.analysis.why})` : ''}`] : []),
  ];
  if (run.notes) out.push('', '## What the local developer says', '', run.notes);
  if (run.diagnosis) out.push('', '## Why it failed (local diagnoser)', '', run.diagnosis);
  for (const p of run.previous ?? []) out.push('', `- Retried from ${p.from} at ${when(p.at)}${p.why ? `: ${p.why}` : ''} (the earlier attempt ${p.status}; kept in the run's .json)${p.undone?.length ? `; undone: ${p.undone.join(', ')}` : ''}`);
  for (const i of run.interrupted ?? []) out.push('', `- Interrupted at ${i.stage}${i.step ? ` · ${i.step}` : ''} (${when(i.at)}): the process that ran it stopped; undone: ${i.undone.join(', ') || 'nothing'}; the trace log is ${RUNS_DIR}/${run.id}.log`);
  const files = run.stages.flatMap((st) => st.steps.filter((s) => s.file?.endsWith('.nuc') && s.code).map((s) => `- \`${s.file}\` (${s.actor}, ${s.status})`));
  if (files.length) out.push('', '## Files written', '', ...[...new Set(files)]);
  const open = run.stages.flatMap((st) => st.steps.filter((s) => s.status === 'failed').map((s) => `- ${st.title} · ${s.title}: ${s.summary}`));
  const unmet = (run.acceptance ?? []).filter((a) => !a.met).map((a) => `- Acceptance criterion not shown met: ${a.criterion} (${a.evidence})`);
  if (open.length || unmet.length) out.push('', '## Left for the reviewer', '', ...open, ...unmet);
  if (run.acceptance?.length) out.push('', '## Acceptance criteria', '', ...run.acceptance.map((a) => `- [${a.met ? 'x' : ' '}] ${a.criterion} — ${a.evidence}`));
  for (const st of run.stages) {
    out.push('', `## ${st.title} — ${st.status}`);
    for (const s of st.steps) {
      out.push('', `### ${s.title} (${s.actor}, ${s.status})`, '');
      if (s.summary) out.push(s.summary, '');
      if (s.file) out.push(`File: \`${s.file}\``, '');
      if (s.tool) out.push(`Tool: \`${s.tool}\``, '');
      if (s.trace.length) out.push(...s.trace.map((t) => `1. **${t.step}**: ${t.detail.replace(/\s+/g, ' ').slice(0, 300)}`), '');
      if (s.decisions?.length) out.push('Decisions:', '', ...s.decisions.map((d) => `- ${d.what} — because ${d.why}`), '');
      if (s.agent) out.push('What the agent read:', '', '```', clip(s.agent, 30), '```', '');
      if (s.log && s.status === 'failed') out.push('Log:', '', '```', clip(s.log, 40), '```', '');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

// ---------- context suggestions ----------

export interface Suggestion {
  path: string;
  kind: 'agents' | 'spec' | 'context' | 'adr' | 'skill' | 'agent' | 'doc' | 'graph';
  reason: string;
  score: number;
}

function walk(dir: string, depth: number, out: string[]): void {
  if (depth < 0 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') && !['.claude', '.agents', '.cursor'].includes(e.name)) continue;
    if (['node_modules', 'build', 'dist', 'out', '.venv', 'target'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth - 1, out);
    else if (e.name.endsWith('.md') || e.name.endsWith('.mdc')) out.push(p);
  }
}

/** The files worth giving the agents for this spec: the project's agent instructions always, then the specs,
 * context, ADRs, skills and agent definitions whose words match the spec best. */
export function suggestContext(root: string, text: string): Suggestion[] {
  const files: string[] = [];
  walk(root, 4, files);
  walk(path.join(os.homedir(), '.claude', 'skills'), 2, files);
  walk(path.join(os.homedir(), '.claude', 'agents'), 1, files);
  const words = new Set(text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []);
  const out: Suggestion[] = [];
  for (const f of files) {
    const rel = f.startsWith(root) ? path.relative(root, f) : f.replace(os.homedir(), '~');
    const name = path.basename(f);
    let kind: Suggestion['kind'] = 'doc';
    if (/^(AGENTS|CLAUDE|GEMINI)\.md$/.test(name) || rel.includes('.cursor/rules')) kind = 'agents';
    else if (name === 'SKILL.md') kind = 'skill';
    else if (rel.includes('.claude/agents') || rel.includes('/agents/')) kind = 'agent';
    else if (rel.startsWith('specs') || rel.includes('/spec/')) kind = 'spec';
    else if (rel.includes('/adr/')) kind = 'adr';
    else if (rel.includes('/context/')) kind = 'context';
    let head = '';
    try {
      head = fs.readFileSync(f, 'utf8').slice(0, 4000).toLowerCase();
    } catch {
      continue;
    }
    let hits = 0;
    for (const w of words) if (head.includes(w)) hits += 1;
    const score = (kind === 'agents' ? 100 : 0) + hits * (kind === 'skill' ? 2 : 1);
    if (kind !== 'agents' && hits < 2) continue;
    const reason = kind === 'agents' ? 'instructions for agents in this project' : `${hits} words of the spec`;
    out.push({ path: rel, kind, reason, score });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 24);
}

// ---------- spec sources ----------

export interface Issue {
  key: string;
  title: string;
  description: string;
  criteria: string[];
  url: string;
}

/** Plain text of Jira's document format (ADF). */
function adfText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  const inner = (n.content ?? []).map(adfText).join(n.type === 'bulletList' || n.type === 'orderedList' ? '' : '');
  if (n.type === 'text') return n.text ?? '';
  if (n.type === 'paragraph' || n.type === 'heading') return inner + '\n';
  if (n.type === 'listItem') return '- ' + inner.trim() + '\n';
  return inner;
}

/** The acceptance criteria of a description: the list after a line that says so. */
export function criteriaOf(text: string): string[] {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => /acceptance criteria|criterios de aceptaci/i.test(l));
  if (at < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(at + 1)) {
    const m = l.match(/^\s*(?:[-*]|\d+[.)]|\[[ x]\])\s+(.*)$/);
    if (m) out.push(m[1].trim());
    else if (out.length && l.trim() === '') break;
  }
  return out;
}

export interface JiraAuth {
  baseUrl: string;
  email: string;
  token: string;
  criteriaField?: string;
}

async function jira(auth: JiraAuth, route: string): Promise<unknown> {
  const r = await fetch(auth.baseUrl.replace(/\/$/, '') + route, {
    headers: { Authorization: 'Basic ' + Buffer.from(`${auth.email}:${auth.token}`).toString('base64'), Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Jira ${route}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function jiraIssue(auth: JiraAuth, key: string): Promise<Issue> {
  if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(key)) throw new Error(`'${key}' is not a Jira key (PROJ-123)`);
  const fields = ['summary', 'description', auth.criteriaField].filter(Boolean).join(',');
  const data = (await jira(auth, `/rest/api/3/issue/${key}?fields=${fields}`)) as { fields: Record<string, unknown> };
  const description = adfText(data.fields.description).trim();
  const own = auth.criteriaField ? adfText(data.fields[auth.criteriaField]) : '';
  const criteria = own ? own.split('\n').map((l) => l.replace(/^[-*]\s*/, '').trim()).filter(Boolean) : criteriaOf(description);
  return { key, title: String(data.fields.summary ?? key), description, criteria, url: `${auth.baseUrl.replace(/\/$/, '')}/browse/${key}` };
}

/** The open issues assigned to the user. */
export async function jiraMine(auth: JiraAuth): Promise<{ key: string; title: string }[]> {
  const jql = encodeURIComponent('assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
  const data = (await jira(auth, `/rest/api/3/search/jql?jql=${jql}&fields=summary&maxResults=30`)) as { issues: { key: string; fields: { summary: string } }[] };
  return data.issues.map((i) => ({ key: i.key, title: i.fields.summary }));
}

/** A GitHub issue through the `gh` CLI (its own login). */
export async function githubIssue(root: string, ref: string): Promise<Issue> {
  if (!/^[\w.-]+\/[\w.-]+#\d+$|^#?\d+$/.test(ref)) throw new Error(`'${ref}' is not an issue (123, #123 or owner/repo#123)`);
  const [repo, num] = ref.includes('/') ? ref.split('#') : ['', ref.replace('#', '')];
  const args = ['issue', 'view', num, '--json', 'title,body,url', ...(repo ? ['--repo', repo] : [])];
  const out = await capture('gh', args, root);
  if (out.code !== 0) throw new Error(out.text.trim() || 'gh issue view failed');
  const data = JSON.parse(out.text) as { title: string; body: string; url: string };
  return { key: ref, title: data.title, description: data.body, criteria: criteriaOf(data.body), url: data.url };
}

// ---------- recovery ----------

/** A call cut by the watch (too long, or nothing working on it): a passing failure, retried. */
export class StallError extends Error {}

/** `.nuclear/loop/runs/<id>.log`: the run's trace log. */
export function traceFile(run: Run): string {
  return path.join(run.root, RUNS_DIR, `${run.id}.log`);
}

/** A run left `running` by a process that stopped: its unfinished steps are failed and what they wrote is undone, so a
 * retry from the step that failed goes on with the plan where it stopped. Returns false when the run is not orphaned. */
export function recoverRun(run: Run): boolean {
  if (run.status !== 'running' || !orphaned(run.owner)) return false;
  const stuck = run.stages.flatMap((st) => st.steps.filter((x) => x.status === 'running').map((x) => ({ st, x })));
  for (const { x } of stuck) Object.assign(x, { status: 'failed', ended: Date.now(), summary: 'interrupted: the process that ran it stopped (the editor was closed or crashed)' });
  for (const st of run.stages) if (st.status === 'running') Object.assign(st, { status: 'failed', ended: Date.now() });
  const passed = new Set(run.stages.flatMap((st) => st.steps.filter((x) => x.status === 'passed').map((x) => x.id)));
  const undone = rollback(run.root, run.writes ?? [], (id) => passed.has(id));
  run.writes = (run.writes ?? []).filter((w) => passed.has(w.step));
  const where = stuck[0] ?? { st: run.stages.find((st) => st.status === 'failed') ?? run.stages[0], x: undefined };
  (run.interrupted ??= []).push({ at: Date.now(), stage: where.st.id, step: where.x?.title ?? '', undone });
  run.status = 'failed';
  run.ended = Date.now();
  atomicWrite(path.join(run.root, RUNS_DIR, `${run.id}.json`), JSON.stringify(run, null, 2));
  trace(traceFile(run), { event: 'recovered', stage: where.st.id, step: where.x?.id, detail: `undone: ${undone.join(', ') || 'nothing'}` });
  return true;
}

/** The orphaned runs of a project, recovered (to resume them). */
export function recoverRuns(root: string): Run[] {
  return listRuns(root).filter((r) => recoverRun(r));
}

// ---------- processes ----------

/** The environment of every command the pipeline runs: the PATH it was given plus the folders the NuclearLang
 * installers write to (`nuclear`, `dragonfly`, `nuclear-graph`, `claude` live there). An editor started from the
 * desktop does not read the shell's profile, so `~/.local/bin` is often missing from its PATH. */
export function toolEnv(env: NodeJS.ProcessEnv = process.env, home = os.homedir(), platform = process.platform): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const sep = platform === 'win32' ? ';' : ':';
  const extra = platform === 'win32'
    ? [env.NUCLEAR_INSTALL && path.join(env.NUCLEAR_INSTALL, 'bin'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'nuclearlang', 'bin')]
    : [env.PREFIX && path.join(env.PREFIX, 'bin'), path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  const dirs = [...(env[key] ?? '').split(sep), ...extra].filter((d): d is string => !!d);
  return { ...env, [key]: [...new Set(dirs)].join(sep) };
}

function capture(cmd: string, args: string[], cwd: string): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: toolEnv() });
    let text = '';
    p.stdout.on('data', (d) => (text += d));
    p.stderr.on('data', (d) => (text += d));
    p.on('error', (e) => resolve({ code: 127, text: String(e) }));
    p.on('close', (code) => resolve({ code: code ?? 1, text }));
  });
}

/** `capture` with `input` on stdin (`dragonfly explain` reads the output to explain). */
function captureInput(cmd: string, args: string[], cwd: string, input: string): Promise<{ code: number; text: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: toolEnv() });
    let text = '';
    p.stdout.on('data', (d) => (text += d));
    p.stderr.on('data', (d) => (text += d));
    p.on('error', (e) => resolve({ code: 127, text: String(e) }));
    p.on('close', (code) => resolve({ code: code ?? 1, text }));
    p.stdin.end(input);
  });
}

/** Exit code of a command killed because it ran longer than its limit. */
export const TIMED_OUT = 124;

function shell(command: string, cwd: string, onData: (s: string) => void, keep: (p: ChildProcess) => void, limitMs = 0): Promise<number> {
  return new Promise((resolve) => {
    const p = process.platform === 'win32' ? spawn('cmd', ['/C', command], { cwd, env: toolEnv() }) : spawn('sh', ['-c', command], { cwd, env: toolEnv(), detached: true });
    keep(p);
    // a command that hangs (a test waiting for ever) is killed with its children after its limit
    let timedOut = false;
    const timer = limitMs > 0 ? setTimeout(() => {
      timedOut = true;
      onData(`\n[killed: no end after ${Math.round(limitMs / 60000)} min]\n`);
      try {
        if (process.platform === 'win32' || !p.pid) p.kill();
        else process.kill(-p.pid, 'SIGKILL');
      } catch {
        p.kill();
      }
    }, limitMs) : undefined;
    p.on('close', () => timer && clearTimeout(timer));
    p.stdout?.on('data', (d) => onData(String(d)));
    p.stderr?.on('data', (d) => onData(String(d)));
    p.on('error', (e) => {
      onData(String(e));
      resolve(127);
    });
    p.on('close', (code) => resolve(timedOut ? TIMED_OUT : code ?? 1));
  });
}

// ---------- the engine ----------

/** Runs a spec through the pipeline. Emits `change` with the run on every step it starts or ends. */
export class LoopEngine extends EventEmitter {
  private stopped = false;
  private children: ChildProcess[] = [];
  private written: { path: string; code: string; kind: string }[] = [];

  constructor(
    readonly run: Run,
    readonly config: LoopConfig,
  ) {
    super();
    upgradeRun(run);
  }

  stop(): void {
    this.stopped = true;
    for (const c of this.children) c.kill();
  }

  private save(): void {
    const dir = path.join(this.run.root, RUNS_DIR);
    // atomic: a crash while saving leaves the previous state whole, never half a file
    atomicWrite(path.join(dir, `${this.run.id}.json`), JSON.stringify(this.run, null, 2));
    atomicWrite(path.join(dir, `${this.run.id}.md`), journalMarkdown(this.run));
    this.emit('change', this.run);
  }

  /** The run's trace log: one line per event, appended (what tells where a broken run stopped). */
  private log(event: string, stage?: Stage, s?: Step, detail?: string): void {
    trace(traceFile(this.run), { event, stage: stage?.id, step: s?.id, detail });
  }

  /** Writes a project file and keeps what was there before (the ledger the recovery undoes). */
  private writeFile(rel: string, text: string, s: Step): void {
    const file = path.join(this.run.root, rel);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    (this.run.writes ??= []).push({ path: rel, step: s.id, before, at: Date.now(), after: digest(text) });
    this.save(); // the ledger first: a crash after the write can still undo it
    atomicWrite(file, text);
    this.log('write', undefined, s, rel);
  }

  private stage(id: StageId): Stage {
    return this.run.stages.find((s) => s.id === id)!;
  }

  private step(stage: Stage, title: string, actor: Actor, extra: Partial<Step> = {}): Step {
    // the number after the highest one of the stage: the steps kept from an earlier attempt keep theirs
    const last = Math.max(0, ...stage.steps.map((x) => Number(x.id.split('-').pop()) || 0));
    const s: Step = { id: `${stage.id}-${last + 1}`, title, actor, status: 'running', started: Date.now(), summary: '', log: '', trace: [], ...extra };
    stage.steps.push(s);
    this.save();
    this.log('step', stage, s, title);
    return s;
  }

  /** A choice of a step and its reason: kept with the step (the graph shows it) and in the trace log. */
  private decide(s: Step, what: string, why: string): void {
    (s.decisions ??= []).push({ what, why });
    this.log('decision', undefined, s, `${what} — because ${why}`.slice(0, 300));
  }

  private end(s: Step, status: Status, summary: string): void {
    s.status = status;
    s.summary = summary;
    s.ended = Date.now();
    this.save();
    this.log(status, undefined, s, summary.slice(0, 200));
  }

  /** Runs the pipeline. A run that already ran is run again from `from` (default: the first stage that failed): the
   * stages before it are kept as they ended and the earlier attempt is kept in `previous`. `step` says how much of
   * that stage is kept: `false` nothing (the whole stage again), `true` every step that passed (it goes on from the
   * one that failed), a step's id every step before that one (that step and all after it run again, whether it had
   * passed or failed). What the steps left out wrote is undone first, so a retry never builds on a broken attempt.
   * A run made by an older engine lacks what was added since: it starts again from scratch (`restart`). */
  async start(from?: StageId, step: boolean | string = false): Promise<Run> {
    this.guard();
    if (this.run.status !== 'pending' && this.run.engine !== ENGINE) return this.restart('this run was made by an older version of the Loop, which had no analysis of the request and no Generate stage: it runs again from the specification');
    const ids = this.run.stages.map((st) => st.id);
    const owning = typeof step === 'string' ? this.run.stages.find((st) => st.steps.some((x) => x.id === step))?.id : undefined;
    const first = owning ?? from ?? this.run.stages.find((st) => st.status === 'failed')?.id;
    const resume = first && this.run.stages.some((st) => st.status !== 'pending') ? ids.indexOf(first) : -1;
    if (resume >= 0) {
      const earlier = structuredClone(this.run.stages.slice(resume));
      const dropped: Step[] = [];
      for (const [i, st] of this.run.stages.slice(resume).entries()) {
        const at = typeof step === 'string' ? st.steps.findIndex((x) => x.id === step) : -1;
        // the check of the connections is made again by every attempt: the old one is not kept
        const keep = i > 0 || step === false ? [] : st.steps.filter((x, n) => x.status === 'passed' && x.title !== 'Check the connections' && (at < 0 || n < at));
        dropped.push(...st.steps.filter((x) => !keep.includes(x)));
        Object.assign(st, { status: 'pending', steps: keep, started: undefined, ended: undefined });
      }
      const named = typeof step === 'string' ? earlier[0].steps.find((x) => x.id === step)?.title : undefined;
      const why = named ? `from the step "${named}" (it and every step after it run again)` : step === true ? 'from the step that failed (the steps that passed are kept)' : `the whole stage ${first} again`;
      this.forget(first!, earlier, why, this.undo(dropped));
      // a plan made again is a new plan: only the pieces the user wrote stay
      if (resume <= ids.indexOf('plan') && !this.planKept()) this.run.spec.pieces = this.run.spec.pieces.filter((p) => p.by === 'you');
      this.restoreWritten();
    }
    return this.go(ids, resume, resume >= 0 ? `from ${first}: ${this.run.previous!.at(-1)!.why}` : this.run.spec.title);
  }

  /** The whole pipeline again from the specification: every file the run wrote goes back to what it was, the analysis
   * and the plan are made again, and the earlier attempt is kept in `previous`. `why` is told in the journal. */
  async restart(why = 'from scratch: every stage again, what the run wrote undone first'): Promise<Run> {
    this.guard();
    upgradeRun(this.run);
    const earlier = structuredClone(this.run.stages);
    const undone = this.undo(this.run.stages.flatMap((st) => st.steps), true);
    this.run.stages = STAGES.map((s) => ({ ...s, status: 'pending', steps: [] }));
    this.forget('spec', earlier, why, undone);
    this.run.spec.pieces = this.run.spec.pieces.filter((p) => p.by === 'you');
    this.run.analysis = undefined;
    this.run.acceptance = undefined;
    this.run.engine = ENGINE;
    this.written = [];
    return this.go(this.run.stages.map((st) => st.id), -1, why);
  }

  /** One process at a time: a run another window is running (its heartbeat is fresh) is not started twice. An
   * orphaned one is recovered first: what it left half done is undone. */
  private guard(): void {
    if (this.run.status === 'running' && this.run.owner && this.run.owner.pid !== process.pid && !orphaned(this.run.owner)) {
      throw new Error(`the run '${this.run.id}' is running in another process (pid ${this.run.owner.pid}); stop it there first`);
    }
    if (this.run.status === 'running') recoverRun(this.run);
  }

  /** Undoes what `steps` wrote (every write of the run with `all`): each file goes back to what it was before, unless
   * someone changed it since. Returns the files undone; the ledger keeps only the writes that stay. */
  private undo(steps: Step[], all = false): string[] {
    const gone = new Set(steps.map((x) => x.id));
    const since = Math.min(...steps.map((x) => x.started ?? Infinity));
    // before step ids were unique, a kept step could share its id with one left out: the time of the write decides
    const out = (w: Write) => all || (gone.has(w.step) && w.at >= since);
    const changed: string[] = [];
    // the ledger of an older engine lost its first writes: what it says a file "was" can be what an earlier attempt
    // of this same run wrote. From scratch that is not what was there before the run: the file goes (its text stays
    // in that attempt's step)
    const own = new Set(
      all && this.run.engine !== ENGINE
        ? [this.run.stages, ...(this.run.previous ?? []).map((p) => p.stages)].flat().flatMap((st) => st.steps.map((x) => (x.code ?? '').trim())).filter(Boolean)
        : [],
    );
    const writes = (this.run.writes ?? []).filter(out).map((w) => (w.before !== null && own.has(w.before.trim()) ? { ...w, before: null } : w));
    const undone = rollback(this.run.root, writes, () => false, changed);
    this.run.writes = (this.run.writes ?? []).filter((w) => !out(w));
    return [...undone, ...changed.map((f) => `${f} (kept: changed since the run wrote it)`)];
  }

  /** The attempt that ends here goes to `previous`, with what the new one was asked and what was undone. */
  private forget(from: StageId, stages: Stage[], why: string, undone: string[]): void {
    this.run.previous = [...(this.run.previous ?? []), { at: Date.now(), from, status: this.run.status, stages, why, undone }];
    this.run.notes = undefined;
    this.run.diagnosis = undefined;
    this.run.ended = undefined;
  }

  private async go(ids: StageId[], resume: number, detail: string): Promise<Run> {
    this.run.status = 'running';
    this.run.owner = owner();
    this.save();
    this.log(resume >= 0 ? 'resume' : 'start', undefined, undefined, detail);
    // the heartbeat: a run whose owner stops beating is orphaned (the editor was closed), and is resumed later
    const beat = setInterval(() => {
      this.run.owner = owner();
      this.save();
    }, BEAT_MS);
    beat.unref?.();
    try {
      return await this.stages(ids, resume);
    } finally {
      clearInterval(beat);
    }
  }

  private async stages(ids: StageId[], resume: number): Promise<Run> {
    const order: [StageId, () => Promise<boolean>][] = [
      ['spec', () => this.specStage()],
      ['generate', () => this.generateStage()],
      ['plan', () => this.planStage()],
      ['test', () => this.testsFirstStage()],
      ['code', () => this.codeStage()],
      ['verify', () => this.verifyStage()],
      ['security', () => this.securityStage()],
      ['artifacts', () => this.commandsStage('artifacts', this.config.commands.artifacts, true)],
      ['deploy', () => this.deployStage()],
    ];
    let ok = true;
    let failed: Stage | undefined;
    for (const [id, fn] of order) {
      const stage = this.stage(id);
      if (resume >= 0 && ids.indexOf(id) < resume) continue; // passed in the earlier attempt
      if (!ok || this.stopped) {
        stage.status = 'skipped';
        continue;
      }
      // a stage the strategy of the request has no use for (ADR-0105): a compile error needs no Generate, a rename
      // no tests first
      const wanted = this.run.analysis?.stages ?? [];
      if (id !== 'spec' && wanted.length && !wanted.includes(id)) {
        const out = this.step(stage, 'Not part of this kind of request', 'shell');
        this.decide(out, `leave ${stage.title} out`, `the strategy ${this.run.analysis!.strategy.replace(/^strategy:/, '')} runs only ${wanted.join(', ')}`);
        this.end(out, 'skipped', `${this.run.analysis!.strategy.replace(/^strategy:/, '')} runs ${wanted.join(', ')}`);
        stage.status = 'skipped';
        this.save();
        continue;
      }
      stage.status = 'running';
      stage.started = Date.now();
      this.save();
      this.log('stage', stage);
      try {
        // before the first stage it runs: every service it needs answers, the models are there, the disks have room
        ok = (id !== ids[Math.max(resume, 0)] || !this.config.preflight || (await this.preflight(stage))) && (await fn());
      } catch (e) {
        const s = this.step(stage, 'Unexpected error', 'shell');
        s.log = String(e instanceof Error ? e.stack ?? e.message : e);
        this.end(s, 'failed', String(e instanceof Error ? e.message : e));
        ok = false;
      }
      const skippedAll = stage.steps.length > 0 && stage.steps.every((s) => s.status === 'skipped');
      stage.status = ok ? (skippedAll ? 'skipped' : 'passed') : 'failed';
      stage.ended = Date.now();
      if (!ok) failed ??= stage;
      this.save();
    }
    this.run.status = this.stopped ? 'skipped' : ok ? 'passed' : 'failed';
    this.run.ended = Date.now();
    if (failed && !this.stopped) await this.diagnose(failed);
    if (!this.stopped) await this.document();
    this.save();
    this.log('end', undefined, undefined, this.run.status);
    return this.run;
  }

  /** The services this run needs, checked before it starts (or goes on): a step of their own, so a failure is told
   * at once (the Developer down, a model not pulled, a full disk) instead of half way. */
  private async preflight(stage: Stage): Promise<boolean> {
    const s = this.step(stage, 'Check the connections', 'shell');
    const checks = await checkConnections(
      {
        developerUrl: this.config.developerUrl,
        graphUrl: this.config.graphUrl,
        ollamaUrl: this.config.ollamaUrl,
        models: [this.config.coderModel, this.config.assistantModel],
        tools: this.run.spec.lead === 'claude' ? [this.config.claudeCommand || 'claude'] : [],
        folders: [this.run.root, os.tmpdir()],
        minFreeMb: this.config.minFreeMb,
      },
      toolEnv(),
    );
    s.log = checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`).join('\n');
    const bad = checks.filter((c) => !c.ok);
    this.end(s, bad.length ? 'failed' : 'passed', bad.length ? bad.map((c) => c.detail).join('; ') : `${checks.length} checks passed`);
    return !bad.length;
  }

  /** A step of the stage kept from the earlier attempt that passed (for `file`, when given): it is not run again. */
  private kept(stage: Stage, actor: Actor, file?: string): Step | undefined {
    return stage.steps.find((x) => x.status === 'passed' && x.actor === actor && (file === undefined || x.file === file));
  }

  /** Whether the plan of the earlier attempt stays (its step passed and was kept): its pieces are then not made again. */
  private planKept(): boolean {
    return this.stage('plan').steps.some((x) => x.status === 'passed' && x.title !== 'Check the connections');
  }

  /** After a retry: what the earlier attempt wrote, read back from the project (the files are the truth). */
  private restoreWritten(): void {
    this.written = [];
    const files = this.run.spec.pieces.map((p) => ({ path: p.path, kind: p.kind }));
    for (const s of this.stage('test').steps) if (s.file?.endsWith('.nuc')) files.unshift({ path: s.file, kind: 'tests' });
    for (const f of files) {
      const target = path.join(this.run.root, f.path);
      if (fs.existsSync(target) && !this.written.some((w) => w.path === f.path)) this.written.push({ path: f.path, code: fs.readFileSync(target, 'utf8'), kind: f.kind });
    }
  }

  /** The local diagnoser tells why the first failed stage failed and what to do (kind and action by rules, the
   * explanation by the model); the user retries from there. */
  private async diagnose(stage: Stage): Promise<void> {
    const bad = [...stage.steps].reverse().find((s) => s.status === 'failed') ?? stage.steps.at(-1);
    // the agents read Nuclear only: a command's raw output (pytest, node, dart) is told in .nuc terms first
    if (bad && !bad.agent && bad.actor === 'shell' && bad.log) bad.agent = (await this.explain(bad.log)).text;
    let failure = [bad?.summary, bad?.agent ?? bad?.log].filter(Boolean).join('\n\n');
    // a class the compiler does not know (N0220) that the plan never had: the plan, not the code, is what is missing
    const absent = [...new Set([...failure.matchAll(/N0220 '([A-Z]\w*)'/g)].map((m) => m[1]))].filter((n) => !this.planned().includes(n));
    if (absent.length) failure = `${absent.join(', ')} is not in the plan (${this.planSummary()}): the plan does not cover the spec.\n\n${failure}`;
    const s = this.step(stage, 'Why it failed', 'diagnoser');
    this.decide(s, `diagnose "${bad?.title ?? stage.title}"`, 'it is the last step of the stage that failed');
    if (absent.length) this.decide(s, 'blame the plan, not the code', `the compiler does not know ${absent.join(', ')} and no piece of the plan declares it`);
    const r = await this.developer('/developer/diagnose', { task: `${stage.title} · ${bad?.title ?? ''}`, platform: this.run.platform, path: this.run.root, context: failure.slice(-8000) || 'no output' }, s);
    s.trace = r.ok ? [...s.trace, ...(r.data.trace ?? [])] : s.trace;
    s.log = r.ok ? String(r.data.report ?? '') : r.error;
    this.run.diagnosis = s.log;
    // the stage stays failed: this step only explains it
    this.end(s, 'skipped', r.ok ? s.log.split('\n').slice(0, 2).join(' · ') : 'the diagnoser did not answer');
  }

  /** The local documenter reads the journal and writes what was done (the reviewer reads it first). */
  private async document(): Promise<void> {
    const r = await this.developer('/developer/document', { task: this.run.spec.title, platform: this.run.platform, context: journalMarkdown(this.run) });
    this.run.notes = r.ok ? String(r.data.report ?? '').trim() : `(the local documenter did not answer: ${r.error})`;
  }

  // spec: the file and its criteria

  private async specStage(): Promise<boolean> {
    const stage = this.stage('spec');
    const spec = this.run.spec;
    const file = path.join(SPECS_DIR, `${spec.id}`, 'spec.md');
    const s = this.step(stage, 'Spec written', 'you', { file });
    const text = specMarkdown(spec);
    this.writeFile(file, text, s);
    s.log = text;
    this.end(s, 'passed', file);
    const c = this.step(stage, 'Acceptance criteria', 'you');
    c.log = spec.criteria.map((x) => `- ${x}`).join('\n');
    this.end(c, spec.criteria.length ? 'passed' : 'failed', spec.criteria.length ? `${spec.criteria.length} criteria` : 'a spec needs at least one acceptance criterion');
    return spec.criteria.length > 0 && (await this.analyze(stage));
  }

  /** Which kind of request the spec is (a whole system, one screen, a rename, a failing test...) and what the strategy
   * of that kind asks of the run (ADR-0105): asked to the local analyst before anything is generated or planned. It
   * reads the spec's own words, never the context files. A request that lacks a fact its strategy cannot start
   * without stops here, with the questions; so does one that is not a run at all (a question, a command). A
   * Developer without an analyst leaves the run as it always was: every stage. */
  private async analyze(stage: Stage): Promise<boolean> {
    const s = this.step(stage, 'Analysis: which kind of request this is', 'planner');
    const r = await this.developer('/developer/analyze', { spec: this.specPrompt(), platform: this.run.platform, strategy: this.run.spec.strategy ?? '' }, s);
    if (!r.ok || !r.data.strategy) {
      this.run.analysis = undefined;
      this.end(s, 'skipped', r.ok ? 'the graph has no strategies: every stage runs' : `no analysis, every stage runs (${r.error.split('\n')[0]})`);
      return true;
    }
    const a: Analysis = {
      strategy: String(r.data.strategy), title: String(r.data.title ?? ''), why: String(r.data.why ?? ''), mode: String(r.data.mode ?? 'write'),
      stages: (r.data.stages ?? []) as string[], lead: String(r.data.lead ?? 'local'), source: String(r.data.source ?? 'plan'),
      generate: (r.data.generate ?? []) as string[][], pieces: (r.data.pieces ?? []) as Piece[], questions: (r.data.questions ?? []) as string[],
      limits: (r.data.limits ?? []) as string[], report: String(r.data.report ?? ''),
    };
    this.run.analysis = a;
    s.trace = r.data.trace ?? [];
    s.log = a.report;
    const name = a.strategy.replace(/^strategy:/, '');
    this.decide(s, `follow the strategy ${name}: ${a.title.replace(/^Strategy: /, '')}`, this.run.spec.strategy ? 'the spec names it itself' : a.why || 'it is the closest in meaning to the request');
    if (a.stages.length) this.decide(s, `run ${a.stages.filter((x) => x !== 'spec').join(' → ')}`, `it is what a request of this kind needs (mode: ${a.mode}; pieces from: ${a.source})`);
    for (const t of s.trace.filter((x) => x.step === 'generator')) this.decide(s, t.detail.includes(': accepted') ? `generate with ${t.detail.replace(/: accepted$/, '')}` : `do not generate with ${t.detail.split(': ')[0]}`, t.detail.includes(': accepted') ? "the generator's dry run accepted it" : `its dry run refused it: ${t.detail.split(': ').slice(1).join(': ')}`);
    for (const l of a.limits) this.decide(s, 'tell the user a limit', l);
    if (a.questions.length) {
      this.end(s, 'failed', `${name}: the request does not say: ${a.questions[0]}${a.questions.length > 1 ? ` (and ${a.questions.length - 1} more: read this step)` : ''}`);
      return false;
    }
    if (!a.stages.length) {
      const how = a.mode === 'answer' ? 'ask it in the chat' : a.mode === 'commands' ? 'it is done with commands' : 'it needs a lead or your own hands';
      this.end(s, 'failed', `${name}: this kind of request is not a run of the Loop (${how}); its plan is in this step`);
      s.log = `${a.report}\n\nThe plan of ${a.strategy}: nuclear-graph card ${a.strategy}`;
      return false;
    }
    this.end(s, 'passed', `${name}${a.why ? ` (${a.why})` : ''}${a.limits.length ? ` · ${a.limits.length} thing(s) beyond the platform or the local agents: read this step` : ''}`);
    return true;
  }

  private contextText(): string {
    const parts: string[] = [];
    for (const c of this.run.spec.context) {
      const p = c.startsWith('~') ? path.join(os.homedir(), c.slice(1)) : path.isAbsolute(c) ? c : path.join(this.run.root, c);
      try {
        parts.push(`### ${c}\n\n${fs.readFileSync(p, 'utf8').slice(0, 6000)}`);
      } catch {
        // gone since the form
      }
    }
    return parts.join('\n\n');
  }

  private specPrompt(): string {
    const spec = this.run.spec;
    return `# ${spec.title}\n\n${spec.description}\n\n## Acceptance criteria\n\n${spec.criteria.map((c) => `- ${c}`).join('\n')}`;
  }

  // generate: what follows from the data, by the CLI

  /** The files the generators wrote in this run: the planner leaves them out, the coder never rewrites them. */
  private generated(): string[] {
    return [...new Set(this.stage('generate').steps.flatMap((s) => s.files ?? []))];
  }

  private async generateStage(): Promise<boolean> {
    const stage = this.stage('generate');
    const specFile = path.join(SPECS_DIR, this.run.spec.id, 'spec.md');
    // what the spec says itself (its Resources, its GET <url> lines), then what the analysis read in its plain words
    const calls: string[][] = specResources(this.run.spec, this.run.platform).map((resource) => {
      const words = resource.match(/"[^"]*"|\S+/g) ?? [];
      return ['resource', ...words, ...(words.some((w) => w === '--from-json' || w === '--from-spec' || w === '--fields') ? [] : ['--from-spec', specFile])];
    });
    for (const call of this.run.analysis?.generate ?? []) if (!calls.some((c) => c.slice(0, 3).join(' ') === call.slice(0, 3).join(' '))) calls.push(call);
    if (!calls.length) {
      this.end(this.step(stage, 'Nothing to generate', 'shell'), 'skipped', 'the spec names no resource (a GET <url> line, a Resources section, or a thing with its fields in plain words)');
      return true;
    }
    const said = specResources(this.run.spec, this.run.platform).length;
    for (const [i, call] of calls.entries()) {
      if (this.stopped) return false;
      const why = i >= said ? 'the analysis read this resource in the plain words of the request, and the dry run accepted it' : this.run.spec.resources?.length ? 'the spec lists it under Resources' : 'the spec has a `GET <url>` line for it: its fields come from the spec (its example answer, else its table)';
      if ((await this.gen(stage, call, why)) !== 0) return false;
    }
    // the project map the planner and the tester read, with what was generated
    return this.commands(stage, ['nuclear check .'], false);
  }

  /** One `dragonfly gen` call as a step; answers its exit code. What it wrote goes to the ledger, so a crash or a
   * failed run undoes it like an agent's file. */
  private async gen(stage: Stage, call: string[], why: string): Promise<number> {
    const command = ['dragonfly', 'gen', ...call].map((a) => (/^[\w./:,=-]+$/.test(a) ? a : `'${a.replace(/^"|"$/g, '').replace(/'/g, "'\\''")}'`)).join(' ');
    const before = nucFiles(this.run.root);
    const s = this.step(stage, command, 'shell', { input: command });
    this.decide(s, `write ${call[0]} ${call.slice(1, 3).join(' ')} with the generator, not with a model`, why);
    const code = await shell(command, this.run.root, (d) => {
      s.log = (s.log + d).slice(-60000);
      this.emit('change', this.run);
    }, (p) => this.children.push(p), this.config.commandTimeoutMs);
    const after = nucFiles(this.run.root);
    const changed = [...after].filter(([f, text]) => before.get(f) !== text).map(([f]) => f);
    for (const f of changed) (this.run.writes ??= []).push({ path: f, step: s.id, before: before.get(f) ?? null, at: Date.now(), after: digest(after.get(f)!) });
    s.files = changed;
    s.trace = changed.map((f) => ({ step: before.has(f) ? 'changed' : 'wrote', detail: f }));
    this.save();
    this.end(s, code === 0 ? 'passed' : 'failed', code === 0 ? `${changed.length} files` : `exit ${code}: ${lastLine(s.log)}`);
    return code;
  }

  /** Each use case the coder wrote is wired by the generator, never by a model (ADR-0105): its alias in the facade
   * and, on the backend, its route when the spec gives one (`POST orders/{id}/cancel`: in the sentence about it, or
   * the spec's only route for the run's only use case). Left
   * alone: a use case the facade already has, and a route when the plan has a controller of that component. A
   * refusal shows in its step and does not fail the run: the project's check decides. */
  private async wire(stage: Stage): Promise<void> {
    // a route the spec gives in another sentence than the one that names the use case is its route when the spec has
    // one route and the run one use case (an API's `GET https://...` is no route of this project)
    const routes = [...this.run.spec.description.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+\/?([A-Za-z][\w/{}:-]*)/g)].filter((m) => !m[2].startsWith('http'));
    const single = new Set(this.written.filter((w) => /\/domain\/usecases\//.test(w.path)).map((w) => w.path)).size === 1 && routes.length === 1 ? routes[0] : null;
    for (const w of this.written) {
      const m = /^components\/([^/]+)\/domain\/usecases\/[^/]+\.nuc$/.exec(w.path);
      const name = /^usecase\s+([A-Z]\w*)/m.exec(w.code)?.[1];
      if (!m || !name || this.stopped) continue;
      const component = m[1];
      const facade = [...nucFiles(this.run.root)].filter(([f]) => f.startsWith(`components/${component}/`) && /component\.nuc$/.test(f));
      if (facade.some(([, text]) => text.includes(`${name}.exec`))) continue;
      const call = ['usecase', component, name];
      const route = /\b(GET|POST|PUT|PATCH|DELETE)\s+\/?([A-Za-z][\w/{}:-]*)/.exec(this.run.spec.pieces.find((p) => p.path === w.path)?.task ?? '') ?? single;
      const controlled = this.run.spec.pieces.some((p) => p.kind === 'controller' && p.path.startsWith(`components/${component}/`));
      if (this.run.platform === 'backend' && route && !controlled) call.push('--route', `${route[1]} ${route[2]}`);
      await this.gen(stage, call, `the coder wrote the use case ${name} and the facade of ${component} has no alias for it${call.includes('--route') ? `; the spec gives its route ${route![1]} ${route![2]}` : ''}`);
    }
  }

  // plan: the pieces

  private async planStage(): Promise<boolean> {
    const stage = this.stage('plan');
    if (this.planKept() && this.run.spec.pieces.length) return true;
    const tooled = (this.run.analysis?.pieces ?? []).map((p) => ({ ...p, by: 'analysis' as const }));
    if (!this.run.spec.pieces.length && tooled.length) {
      // the strategy's pieces are files the project already has (the ones that declare what changes, or every file
      // of a rename, each already written by the tool): no model splits anything
      const s = this.step(stage, 'Pieces from the analysis', 'shell');
      s.log = tooled.map((p) => `${p.path} | ${p.code !== undefined ? 'written by a tool' : p.task}`).join('\n');
      this.decide(s, 'take the pieces from the analysis, ask no planner', `the strategy ${this.run.analysis!.strategy.replace(/^strategy:/, '')} works on files the project already has (pieces from: ${this.run.analysis!.source})`);
      this.run.spec.pieces = tooled;
      this.end(s, 'passed', `${tooled.length} files${tooled.every((p) => p.code !== undefined) ? ', each already written by a tool' : ''}`);
      return true;
    }
    if (!this.run.spec.pieces.length && this.run.analysis && this.run.analysis.source !== 'plan') {
      // the pieces of this kind of request are files the project has, and the request named none: nothing is planned
      // (a bug's file is the one its failure names)
      const none = this.step(stage, 'Nothing to plan', 'shell');
      this.decide(none, 'plan nothing', `the strategy ${this.run.analysis.strategy.replace(/^strategy:/, '')} takes its files from the project (${this.run.analysis.source}) and the request named none`);
      this.end(none, 'skipped', `${this.run.analysis.strategy.replace(/^strategy:/, '')} plans no new file`);
      return true;
    }
    if (this.run.spec.pieces.length) {
      const s = this.step(stage, 'Pieces from the spec', 'you');
      s.log = this.run.spec.pieces.map((p) => `${p.path} | ${p.kind} | ${p.task}`).join('\n');
      this.decide(s, 'use the pieces of the spec, ask no planner', 'the spec brings its own pieces (written in the form or under Pieces)');
      this.end(s, 'passed', `${this.run.spec.pieces.length} pieces written in the form`);
      return true;
    }
    if (this.run.spec.lead === 'claude') {
      const s = this.step(stage, 'Claude splits the spec into pieces', 'claude');
      const prompt = `${this.specPrompt()}${this.generatedNote()}\n\n## Context\n\n${this.contextText()}\n\nThe project is \`${this.run.project}\` (platform ${this.run.platform}, dialect ${this.run.dialect}), in the current folder. First call graph_prompt("plan") and follow it; read the project's files you need. Then answer ONLY a JSON array of pieces: [{"path": "...", "kind": "...", "task": "..."}], each task complete enough for a junior who sees nothing else (names, signatures, the files it uses).`;
      const text = await this.claude(stage, s, prompt, ['Read', 'Glob', 'Grep', 'mcp__nuclear__graph_search', 'mcp__nuclear__graph_prompt', 'mcp__nuclear__nuclear_help', 'mcp__nuclear__nuclear_brief']);
      const pieces = this.withoutGenerated(parsePieces(text).map((p) => ({ ...p, by: 'claude' as const })), s);
      this.run.spec.pieces = pieces;
      const done = pieces.length > 0 || this.generated().length > 0;
      this.end(s, done ? 'passed' : 'failed', pieces.length || done ? `${pieces.length} pieces` : 'no pieces in the answer');
      return done;
    }
    const s = this.step(stage, 'The local planner splits the spec', 'planner');
    this.decide(s, 'ask the local planner', 'the spec brings no pieces, the analysis gave none, and no frontier model leads this run');
    // only the spec is split: the context files are instructions for the agents, and their words are not the request's
    const r = await this.developer('/developer/plan', { spec: `${this.specPrompt()}${this.generatedNote()}`, platform: this.run.platform });
    if (!r.ok) {
      this.end(s, 'failed', r.error);
      return false;
    }
    s.trace = r.data.trace ?? [];
    s.log = String(r.data.raw ?? '');
    this.run.spec.pieces = this.withoutGenerated(((r.data.pieces ?? []) as Piece[]).map((p) => ({ ...p, by: 'planner' as const })), s);
    for (const p of this.run.spec.pieces) this.decide(s, `plan ${p.kind} in ${p.path}`, p.task.split('\n')[0].slice(0, 200));
    if (!this.run.spec.pieces.length && this.generated().length) this.decide(s, 'plan no piece', `the generators already wrote ${this.generated().length} files and the planner named nothing else to build`);
    const done = this.run.spec.pieces.length > 0 || this.generated().length > 0;
    // what the planner found beyond the platform or the local agents is said where the user reads first
    const limits = ((r.data.limits ?? []) as string[]).length;
    this.end(s, done ? 'passed' : 'failed', `${this.run.spec.pieces.length} pieces${this.generated().length ? ` (besides ${this.generated().length} generated files)` : ''}${limits ? ` · ${limits} thing(s) beyond the platform or the local agents: read this step` : ''}`);
    return done;
  }

  /** What the planner reads about the generated files: they are done, plan only what is left. */
  private generatedNote(): string {
    const files = this.generated();
    return files.length ? `\n\n## Already generated (done and compiling: do not plan them again)\n\n${files.map((f) => `- ${f}`).join('\n')}\n\nPlan only what these do not do (a use case with its own rules, a view's details); plan nothing when they do everything.` : '';
  }

  /** A planned piece the generators already wrote (the same file, or the same declaration elsewhere) is dropped. */
  private withoutGenerated(pieces: Piece[], s: Step): Piece[] {
    const files = this.generated();
    const stems = new Set(files.map((f) => path.basename(f, '.nuc')));
    const done = (p: Piece) => files.includes(p.path) || stems.has(path.basename(p.path, '.nuc'));
    for (const p of pieces.filter(done)) this.decide(s, `drop the planned piece ${p.path}`, 'a generator already wrote that file in this run');
    return pieces.filter((p) => !done(p));
  }

  // code: each piece by the local coder, Claude for what it cannot, then the project's check

  private async codeStage(): Promise<boolean> {
    const stage = this.stage('code');
    for (const piece of this.run.spec.pieces) {
      if (this.stopped) return false;
      if (this.kept(stage, 'coder', piece.path) && fs.existsSync(path.join(this.run.root, piece.path))) continue; // written before the retry
      if (piece.code !== undefined) {
        const s = this.step(stage, piece.path, 'shell', { file: piece.path, input: piece.task });
        this.decide(s, 'write the file as the tool gave it, ask no model', 'the analysis already has its whole text (a rename is done by a tool)');
        s.code = piece.code;
        this.writeFile(piece.path, piece.code, s);
        this.written.push({ path: piece.path, code: piece.code, kind: piece.kind });
        this.end(s, 'passed', 'written by a tool');
        continue;
      }
      const target = path.join(this.run.root, piece.path);
      const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      const s = this.step(stage, piece.path, 'coder', { file: piece.path, input: piece.task });
      this.decide(s, existing ? 'change the file that exists' : 'write a new file', `the plan asks for ${piece.kind || 'this file'} here (piece by ${piece.by ?? 'the plan'}); the coder reads the ${this.written.length} file(s) written before it`);
      const before = this.written.map((w) => `\`\`\`nuclear\n// ${w.path}\n${w.code}\`\`\``).join('\n\n');
      const context = [existing ? `The file exists; change it as the task says and answer the whole file:\n\`\`\`nuclear\n${existing}\`\`\`` : '', before].filter(Boolean).join('\n\n');
      const r = await this.developer('/developer/code', { task: piece.task, platform: this.run.platform, path: piece.path, kind: piece.kind, context: context.slice(-12000) });
      if (!r.ok) {
        this.end(s, 'failed', r.error);
        return false;
      }
      s.trace = r.data.trace ?? [];
      s.code = String(r.data.code ?? '');
      s.log = String(r.data.check ?? '');
      let ok = r.data.check === 'ok';
      if (!ok && this.run.spec.lead === 'claude') {
        this.decide(s, 'hand the file to Claude', `the local coder left compiler errors after ${r.data.attempts} attempts and Claude leads this run`);
        this.end(s, 'failed', `the local coder left errors after ${r.data.attempts} attempts: Claude takes it`);
        const fix = this.step(stage, `Claude fixes ${piece.path}`, 'claude', { file: piece.path });
        const prompt = `The local developer wrote \`${piece.path}\` for this task and could not fix the compiler's errors.\n\nTask: ${piece.task}\n\nIts answer:\n\`\`\`nuclear\n${s.code}\`\`\`\n\nErrors:\n${s.log}\n\nWrite the corrected file to ${piece.path} (create its folders), check it with nuclear_check until it says ok, and keep the corrected version as an example with graph_remember (collection "examples", the task then the code) so the local developer learns it. Answer the final code in one \`\`\`nuclear block.`;
        const text = await this.claude(stage, fix, prompt, ['Read', 'Write', 'Edit', 'mcp__nuclear__nuclear_check', 'mcp__nuclear__graph_search', 'mcp__nuclear__graph_remember', 'mcp__nuclear__nuclear_help']);
        const code = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : fence(text);
        ok = !!code.trim();
        s.code = code;
        fix.code = code;
        this.end(fix, ok ? 'passed' : 'failed', ok ? 'fixed by Claude' : 'no code');
      } else {
        if (!ok) this.decide(s, 'stop the stage', `the file still has compiler errors after ${r.data.attempts} attempts and no frontier model leads this run`);
        this.end(s, ok ? 'passed' : 'failed', ok ? `ok in ${r.data.attempts} attempt(s)` : String(r.data.check).split('\n')[0]);
      }
      if (!ok) return false;
      this.writeFile(piece.path, s.code ?? '', s);
      this.written.push({ path: piece.path, code: s.code ?? '', kind: piece.kind });
    }
    await this.wire(stage);
    if (await this.commands(stage, this.config.commands.check, true)) return true;
    return this.repairProject(stage);
  }

  /** The pieces compile alone but not together (a name of one used wrong in another): `nuclear fix .` applies the
   * compiler's exact fixes, then the local coder (the tester for a test file) gets each file with its project errors
   * once; what is left goes to Claude when it leads. */
  private async repairProject(stage: Stage): Promise<boolean> {
    // the compiler's exact fixes first (a tool does what needs no thinking); the agents get only what is left
    if (await this.commands(stage, ['nuclear fix .'], true)) return true;
    const errors = await this.projectErrors();
    for (const [file, list] of errors) {
      await this.repairWith(stage, file, `Fix exactly these errors of the project in this file:\n${list.join('\n')}`);
    }
    if (await this.commands(stage, this.config.commands.check, true)) return true;
    if (this.run.spec.lead !== 'claude') return this.commands(stage, this.config.commands.check);
    const left = await this.projectErrors();
    const fix = this.step(stage, 'Claude fixes the project', 'claude');
    const list = [...left].map(([f, l]) => `${f}:\n${l.join('\n')}`).join('\n\n');
    await this.claude(stage, fix, `The project in the current folder has these compiler errors after the local developer wrote its pieces:\n\n${list}\n\nFix them in the .nuc files (never in build/), then call nuclear_check with path "${this.run.root}" until it answers ok. For each fix that a junior could have learned, keep it as an example with graph_remember (collection "examples").`, ['Read', 'Edit', 'Write', 'mcp__nuclear__nuclear_check', 'mcp__nuclear__nuclear_help', 'mcp__nuclear__graph_search', 'mcp__nuclear__graph_remember']);
    const ok = await this.commands(stage, this.config.commands.check);
    this.end(fix, ok ? 'passed' : 'failed', ok ? 'the project compiles' : 'errors left');
    return ok;
  }

  /** `nuclear check . --json` of the project, by file. */
  private async projectErrors(): Promise<Map<string, string[]>> {
    const out = await capture('nuclear', ['check', '.', '--json'], this.run.root);
    const found = new Map<string, string[]>();
    let at = out.text.indexOf('[');
    while (at >= 0) {
      let end = at;
      let list: { file?: string; line?: number; col?: number; code?: string; message?: string; severity?: string }[] | undefined;
      // the JSON arrays of `nuclear check` follow each other: take the longest one that parses from here
      for (let j = out.text.indexOf(']', at); j >= 0; j = out.text.indexOf(']', j + 1)) {
        try {
          list = JSON.parse(out.text.slice(at, j + 1));
          end = j;
          break;
        } catch {
          // a ] inside a message: keep looking
        }
      }
      for (const d of list ?? []) {
        if (d.severity !== 'error' || !d.file) continue;
        const line = `${d.line}:${d.col} ${d.code} ${d.message}`;
        found.set(d.file, [...(found.get(d.file) ?? []), line]);
      }
      at = list ? out.text.indexOf('[', end + 1) : out.text.indexOf('[', at + 1);
    }
    return found;
  }

  // tests first: the local tester writes what the code must do, before the code exists

  private testFile(): string {
    return path.join('test', `${slug(this.run.spec.title).replace(/-/g, '_')}_test.nuc`);
  }

  private projectMap(): string {
    try {
      return fs.readFileSync(path.join(this.run.root, '.nuclear', 'map.md'), 'utf8');
    } catch {
      return '';
    }
  }

  private async testsFirstStage(): Promise<boolean> {
    const stage = this.stage('test');
    if (this.kept(stage, 'tester')) return true;
    if (!this.run.spec.pieces.length && this.generated().length) {
      // every file of the run was generated: the generators write the tests of what they generate (and none for a
      // backend resource that reads another API: a local model would test against the real one)
      const none = this.step(stage, 'Nothing left to test first', 'tester');
      const tests = this.generated().filter((f) => /(^|\/)tests?\//.test(f));
      this.decide(none, 'write no test first', tests.length ? `every file of this run was generated, its tests too (${tests.join(', ')})` : 'every file of this run was generated, and the generators wrote no test: they write none for what cannot run alone (a resource that reads another API)');
      this.end(none, 'skipped', tests.length ? `the generators wrote ${tests.length} test file(s): the verification runs them` : 'every file was generated and none is a test: only the acceptance step holds the criteria against the result');
      return true;
    }
    const file = this.testFile();
    const name = pascal(slug(this.run.spec.title).replace(/-/g, '_'));
    const task = `Tests ${name}: one @test per acceptance criterion, before the code exists.\n${this.run.spec.criteria.map((c) => `- ${c}`).join('\n')}\n\n${this.testNames()}`;
    const s = this.step(stage, 'The local tester writes the tests first', 'tester', { file, input: task });
    const r = await this.developer('/developer/test', { task, platform: this.run.platform, path: file, kind: 'tests', context: this.projectMap().slice(-8000) });
    if (!r.ok) {
      this.end(s, 'failed', r.error);
      return false;
    }
    s.trace = r.data.trace ?? [];
    s.code = String(r.data.code ?? '');
    s.file = file;
    s.log = String(r.data.check ?? '');
    if (r.data.check !== 'ok' || !s.code.trim()) {
      // no tests, no proof: the acceptance criteria would go unchecked and the run would pass empty
      this.end(s, 'failed', `no test file that compiles after ${r.data.attempts ?? 3} attempts: the acceptance criteria would go untested`);
      return false;
    }
    this.writeFile(file, s.code, s);
    this.written.push({ path: file, code: s.code, kind: 'tests' });
    // tests first decide what the code must declare: a class they inject that the plan does not have cannot be written
    // by any piece, so the run stops here, saying so, instead of repairing in circles later
    const missing = this.unplanned(s.code);
    if (missing.length) {
      this.decide(s, 'stop the run here', `the tests inject ${missing.join(', ')} and no piece of the plan declares it: no code could make them pass`);
      this.end(s, 'failed', `the tests need ${missing.join(', ')}, which is not in the plan (${this.planSummary()}): the plan does not cover the spec`);
      return false;
    }
    this.end(s, 'passed', `${file}: checked again with the whole project once the code exists`);
    return true;
  }

  // verification: build and every test; a failure goes back to the coder in Nuclear terms

  private async verifyStage(): Promise<boolean> {
    const stage = this.stage('verify');
    const run = [...this.config.commands.build, ...this.config.commands.test];
    for (let round = 1; round <= 3; round++) {
      if (await this.commands(stage, run, true)) return this.accept(stage);
      const failed = [...stage.steps].reverse().find((x) => x.actor === 'shell' && x.status === 'skipped');
      const told = await this.explain(failed?.log ?? '');
      if (failed) failed.agent = told.text;
      // a bug is in a file the project already has: the failure names it, whoever wrote it. Its test is never the
      // file to repair: a test is not rewritten to pass
      const fixing = this.run.analysis?.mode === 'fix';
      const files = told.files.filter((f) => (fixing ? !f.startsWith('test/') : this.written.some((w) => w.path === f)));
      if (fixing && !files.length && !this.written.some((w) => w.kind !== 'tests')) {
        this.end(this.step(stage, 'Where is the cause?', 'shell'), 'failed', 'the failure names no file of the code, only the test: a test is not rewritten to pass. Name the declaration in the spec, or let a lead find the cause');
        break;
      }
      // no frame in a file of the run: every piece the failure names, else every piece
      const mine = this.written.filter((w) => !fixing || w.kind !== 'tests');
      const targets = files.length ? files : mine.filter((w) => told.text.includes(path.basename(w.path, '.nuc'))).map((w) => w.path);
      if (failed) this.decide(failed, `repair ${(targets.length ? targets : mine.map((w) => w.path)).join(', ') || 'nothing'} (round ${round} of 3)`, files.length ? 'the failure names these files of the run' : targets.length ? 'the failure names no line of the run, but it names these files' : 'the failure names no file of the run: every piece is tried');
      for (const file of targets.length ? targets : mine.map((w) => w.path)) {
        await this.repairWith(stage, file, `The project's tests fail (round ${round}). Fix this file so they pass; the tests say what the code must do (change a test only if it contradicts the spec).\n\n${told.text}`);
      }
    }
    if (this.run.spec.lead === 'claude') {
      const left = [...stage.steps].reverse().find((x) => x.actor === 'shell' && x.status === 'skipped');
      const fix = this.step(stage, 'Claude fixes the failing tests', 'claude');
      await this.claude(stage, fix, `The project's tests still fail after the local developer's repairs:\n\n${left?.agent ?? left?.log ?? ''}\n\nFix the .nuc files (never build/), then run nuclear_check with path "${this.run.root}" and keep each fix a junior could learn with graph_remember (collection "examples").`, ['Read', 'Edit', 'Write', 'mcp__nuclear__nuclear_check', 'mcp__nuclear__nuclear_help', 'mcp__nuclear__graph_search', 'mcp__nuclear__graph_remember']);
      this.end(fix, 'passed', 'done');
    }
    return (await this.commands(stage, run)) && this.accept(stage);
  }

  /** Each acceptance criterion held against what the run left (ADR-0102): the facts come from tools (the files of the
   * run, how many tests they declare, the commands that passed) and the local reviewer says, per criterion, whether
   * they show it met and where. It never fails the run (a small model's verdict is evidence for the reviewer, not a
   * gate): a criterion not shown met is listed as left, so a run never says there is nothing left when there is. */
  private async accept(stage: Stage): Promise<true> {
    const criteria = this.run.spec.criteria;
    const paths = [...new Set([...this.generated(), ...this.written.map((w) => w.path)])].filter((f) => fs.existsSync(path.join(this.run.root, f)));
    const texts = paths.map((f) => ({ path: f, code: fs.readFileSync(path.join(this.run.root, f), 'utf8') }));
    const tests = texts.filter((t) => t.path.startsWith('test/')).reduce((n, t) => n + (t.code.match(/@test\(/g) ?? []).length, 0);
    const facts = [`The run wrote ${texts.length} file(s): ${paths.join(', ') || 'none'}.`, `They declare ${tests} test(s).`, `These commands passed: ${stage.steps.filter((x) => x.actor === 'shell' && x.status === 'passed' && x.input).map((x) => x.input).join('; ') || 'none'}.`].join('\n');
    const s = this.step(stage, 'Acceptance criteria', 'tester', { input: `${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n${facts}` });
    const files = texts.map((t) => `\`\`\`nuclear\n// ${t.path}\n${t.code}\`\`\``).join('\n\n');
    const r = await this.developer('/developer/accept', { task: criteria.map((c, i) => `${i + 1}. ${c}`).join('\n'), platform: this.run.platform, context: `${facts}\n\n${files}`.slice(0, 16000) }, s);
    if (!r.ok) {
      this.run.acceptance = undefined;
      this.end(s, 'skipped', `not checked: the local reviewer did not answer (${r.error.split('\n')[0]})`);
      return true;
    }
    s.trace = r.data.trace ?? [];
    s.log = String(r.data.report ?? '');
    const said = new Map([...s.log.matchAll(/^\s*(\d+)\s*\|\s*(not met|met)\s*\|\s*(.+)$/gim)].map((m) => [Number(m[1]), { met: m[2].toLowerCase() === 'met', evidence: m[3].trim() }]));
    this.run.acceptance = criteria.map((c, i) => ({ criterion: c, met: said.get(i + 1)?.met ?? false, evidence: said.get(i + 1)?.evidence ?? 'the reviewer said nothing about it' }));
    for (const a of this.run.acceptance) this.decide(s, `${a.met ? 'met' : 'not shown met'}: ${a.criterion}`, a.evidence);
    const open = this.run.acceptance.filter((a) => !a.met);
    this.end(s, open.length ? 'skipped' : 'passed', open.length ? `${open.length} of ${criteria.length} not shown met (left for the reviewer): ${open.map((a) => a.criterion).join('; ').slice(0, 300)}` : `${criteria.length} of ${criteria.length} shown met`);
    return true;
  }

  /** A failing output told in Nuclear: `dragonfly explain --json` (the message, a hint and the .nuc lines with their
   * code), never the target language's log. The raw output stays in the step's log. */
  private async explain(log: string): Promise<{ text: string; files: string[] }> {
    const out = await captureInput('dragonfly', ['explain', '--json'], this.run.root, log);
    let got: { title?: string; hint?: string; frames?: { source: string; line: number; name: string }[] } = {};
    try {
      got = JSON.parse(out.text.trim().split('\n').pop() ?? '{}');
    } catch {
      // no line map (nothing built yet): the output's last lines are all there is
      return { text: `The tests fail:\n${log.trim().split('\n').slice(-15).join('\n')}`, files: [] };
    }
    const files: string[] = [];
    const rows = (got.frames ?? []).map((f) => {
      const rel = path.relative(this.run.root, f.source).replace(/\\/g, '/');
      files.push(rel);
      let code = '';
      try {
        code = fs.readFileSync(f.source, 'utf8').split('\n')[f.line - 1]?.trim() ?? '';
      } catch {
        // the file moved since the build
      }
      return `- ${rel}:${f.line}${code ? `  \`${code}\`` : ''}`;
    });
    return { text: [`The tests fail: ${got.title ?? 'error'}`, got.hint ?? '', ...(rows.length ? ['Where, in Nuclear:', ...rows] : [])].filter(Boolean).join('\n'), files: [...new Set(files)] };
  }

  /** One local repair of a file of the run with what is wrong: the tester for a test file, the coder for the rest. */
  /** What a test may use: the planned pieces with their names and signatures, and how to reach them (the
   * declarations do not exist yet when the tests are written first; what exists is in the project map). */
  /** The declarations of the plan (`usecase ListCharacters. The spec says...` → `ListCharacters`). */
  private planned(): string[] {
    return this.run.spec.pieces.map((p) => p.task.match(/^\w+\s+([A-Z]\w*)/)?.[1]).filter((n): n is string => !!n);
  }

  private planSummary(): string {
    const pieces = this.run.spec.pieces;
    return pieces.length ? `the plan has ${pieces.length} piece${pieces.length === 1 ? '' : 's'}: ${pieces.map((p) => `${p.kind} ${p.task.match(/^\w+\s+([A-Z]\w*)/)?.[1] ?? p.path}`).join(', ')}` : 'the plan is empty';
  }

  /** The classes a test injects that neither the plan nor the project declares. */
  private unplanned(code: string): string[] {
    const known = new Set([...this.planned(), ...[...this.projectMap().matchAll(/^\s+- \w+ `([A-Z]\w*)/gm)].map((m) => m[1])]);
    return [...new Set([...code.matchAll(/inject<([A-Z]\w*)>/g)].map((m) => m[1]))].filter((n) => !known.has(n));
  }

  private testNames(): string {
    const pieces = this.run.spec.pieces;
    const planned = pieces.map((p) => `- ${p.kind} in ${p.path}: ${p.task}`).join('\n');
    const injectable = pieces.filter((p) => ['repository', 'usecase', 'appcomponent', 'service', 'tools'].includes(p.kind)).map((p) => p.task.match(/^\w+\s+([A-Z]\w*)/)?.[1]).filter((n): n is string => !!n);
    const how = injectable.length
      ? `Get each instance with inject: ${injectable.map((n) => `${n[0].toLowerCase() + n.slice(1)} = inject<${n}>()`).join(', ')}; call its methods with ~. Inject nothing else.`
      : 'There is nothing to inject: build the models above and check their fields. Do not use inject.';
    return `The pieces that will exist (use exactly these names and signatures, and no other declaration):\n${planned}\n${how}`;
  }

  private async repairWith(stage: Stage, file: string, problem: string): Promise<void> {
    const target = path.join(this.run.root, file);
    if (!fs.existsSync(target)) return;
    const code = fs.readFileSync(target, 'utf8');
    const isTest = this.written.find((w) => w.path === file)?.kind === 'tests' || file.startsWith('test/');
    const others = this.written.filter((w) => w.path !== file).map((w) => `\`\`\`nuclear\n// ${w.path}\n${w.code}\`\`\``).join('\n\n');
    // a test file is repaired against the plan's names: the compiler says what is wrong, the plan what to use instead
    const task = `${problem}\n\n${isTest ? `${this.testNames()}\n\n` : ''}Answer the whole file.`;
    const s = this.step(stage, `Repair ${file}`, isTest ? 'tester' : 'coder', { file, input: task });
    this.decide(s, `give ${file} to the ${isTest ? 'tester' : 'coder'}`, `${isTest ? 'it is a test file: it is repaired against the names of the plan' : 'it is a file of the code'}; ${problem.split('\n')[0].slice(0, 160)}`);
    const r = await this.developer(isTest ? '/developer/test' : '/developer/code', { task, platform: this.run.platform, path: file, kind: this.written.find((w) => w.path === file)?.kind ?? '', context: `The file now:\n\`\`\`nuclear\n${code}\`\`\`\n\nThe files it uses:\n${others}`.slice(-12000) });
    if (r.ok && r.data.check === 'ok' && String(r.data.code).trim()) {
      s.trace = r.data.trace ?? [];
      s.code = String(r.data.code);
      this.writeFile(file, s.code, s);
      const w = this.written.find((x) => x.path === file);
      if (w) w.code = s.code;
      this.end(s, 'passed', `rewritten in ${r.data.attempts} attempt(s)`);
    } else this.end(s, 'failed', r.ok ? String(r.data.check).split('\n')[0] : r.error);
  }

  // security: the local reviewer per new file, then the project's commands

  private async securityStage(): Promise<boolean> {
    const stage = this.stage('security');
    let severe = false;
    for (const w of this.written) {
      if (this.stopped) return false;
      if (this.kept(stage, 'security', w.path)) continue; // reviewed before the retry
      const s = this.step(stage, `Review ${w.path}`, 'security', { file: w.path });
      const r = await this.developer('/developer/security', { task: 'review', platform: this.run.platform, context: w.code });
      if (!r.ok) {
        this.end(s, 'failed', r.error);
        return false;
      }
      s.trace = r.data.trace ?? [];
      s.log = String(r.data.report ?? '');
      const high = /^\s*(critical|high)\b/im.test(s.log);
      severe ||= high;
      const none = /^\s*none\s*$/im.test(s.log) || !s.log.trim();
      this.end(s, high ? 'failed' : 'passed', none ? 'no findings' : high ? 'a high finding: see the report' : 'findings to read, none high');
    }
    const ok = await this.commands(stage, this.config.commands.security);
    return ok && !severe;
  }

  // artifacts and deploy: the project's commands

  private async commandsStage(id: StageId, commands: string[], keep: boolean): Promise<boolean> {
    const stage = this.stage(id);
    const ok = await this.commands(stage, commands);
    if (ok && keep) {
      const s = this.step(stage, 'Keep the output with the run', 'shell');
      const card = readJson(path.join(this.run.root, '.nuclear', 'project.json')) as { output?: string } | undefined;
      const out = path.join(this.run.root, card?.output ?? 'build');
      const dest = path.join(this.run.root, ARTIFACTS_DIR, this.run.id);
      const kept = copyTree(out, dest, ['.venv', 'node_modules', '__pycache__', '.dart_tool']);
      for (const f of ['contract.json', 'openapi.json']) {
        const src = path.join(this.run.root, '.nuclear', f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dest, f));
      }
      this.end(s, 'passed', `${kept} files in ${path.relative(this.run.root, dest)}`);
    }
    return ok;
  }

  private async deployStage(): Promise<boolean> {
    const stage = this.stage('deploy');
    const { seed, integration, deploy } = this.config.commands;
    if (!seed.length && !integration.length && !deploy.length) {
      const s = this.step(stage, 'Nothing to deploy', 'shell');
      this.end(s, 'skipped', `add commands.seed, commands.integration or commands.deploy to ${CONFIG_FILE}`);
      return true;
    }
    return this.commands(stage, [...seed, ...integration, ...deploy]);
  }

  /** Runs `list` in the project. `quiet`: a failure is not drawn as a failed step (a check that a repair follows). */
  private async commands(stage: Stage, list: string[], quiet = false): Promise<boolean> {
    for (const command of list) {
      if (this.stopped) return false;
      const s = this.step(stage, command, 'shell', { input: command });
      const code = await shell(command, this.run.root, (d) => {
        s.log = (s.log + d).slice(-60000);
        this.emit('change', this.run);
      }, (p) => this.children.push(p), this.config.commandTimeoutMs);
      if (code === TIMED_OUT) {
        this.end(s, 'failed', `timed out: no end after ${Math.round(this.config.commandTimeoutMs / 60000)} min (killed)`);
        return false;
      }
      if (code !== 0 && quiet) {
        this.end(s, 'skipped', `exit ${code}: errors to repair`);
        return false;
      }
      this.end(s, code === 0 ? 'passed' : 'failed', code === 0 ? 'exit 0' : `exit ${code}: ${lastLine(s.log)}`);
      if (code !== 0) return false;
    }
    return true;
  }

  // the agents

  /** A call to the local agents. A failure that may pass (the server not up yet, busy, a 5xx) is retried with
   * `backoff` up to `config.retry.attempts` tries in all; each retry is written in the step's trace. */
  private async developer(route: string, input: Record<string, unknown>, step?: Step): Promise<{ ok: true; data: Record<string, any> } | { ok: false; error: string }> {
    // every agent gets the project's folder: with it, it reads by itself the files that declare the names of its task
    const body = { root: this.run.root, ...input };
    const policy = { ...DEFAULT_RETRY, ...this.config.retry };
    let error = '';
    for (let n = 1; ; n++) {
      let wait: number | undefined;
      try {
        const r = await this.watched((signal) => fetch(this.config.developerUrl + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }));
        if (r.ok) return { ok: true, data: (await r.json()) as Record<string, any> };
        error = `${route}: ${r.status} ${(await r.text()).slice(0, 300)}`;
        if (!transientStatus(r.status)) return { ok: false, error };
        wait = retryAfter(r.headers.get('retry-after'));
      } catch (e) {
        error = e instanceof StallError ? e.message : `the local developer is not running at ${this.config.developerUrl} (${String(e)}): start it with nuclear-developer`;
      }
      const target = step ?? this.runningStep();
      if (n >= policy.attempts || this.stopped) {
        if (n > 1) target?.trace.push({ step: 'retry', detail: `gave up after ${n} tries` });
        return { ok: false, error: n > 1 ? `${error} (after ${n} tries)` : error };
      }
      const ms = backoff(n, policy, wait);
      target?.trace.push({ step: 'retry', detail: `try ${n + 1} of ${policy.attempts} in ${(ms / 1000).toFixed(1)} s: ${error.slice(0, 160)}` });
      this.save();
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
  }

  /** A call watched while it waits: cut when it takes longer than `callTimeoutMs`, or when for `stallSeconds` the
   * Developer stops answering or Ollama holds no model (nothing is working on it), so a stuck call is retried instead
   * of waiting for ever. */
  private async watched<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const ctl = new AbortController();
    let why = '';
    const cut = (reason: string) => {
      why = reason;
      ctl.abort();
    };
    const timer = setTimeout(() => cut(`no answer in ${Math.round(this.config.callTimeoutMs / 60000)} min`), this.config.callTimeoutMs);
    const every = Math.min(15_000, Math.max(100, (this.config.stallSeconds * 1000) / 3));
    let idle = 0;
    let down = 0;
    const probe = setInterval(() => {
      void (async () => {
        const dev = await fetch(this.config.developerUrl + '/docs', { signal: AbortSignal.timeout(3000) }).then((r) => r.status < 500, () => false);
        down = dev ? 0 : down + every;
        const busy = await ollamaBusy(this.config.ollamaUrl);
        idle = busy === false ? idle + every : 0;
        const stall = this.config.stallSeconds * 1000;
        const s = this.runningStep();
        if (down >= stall) cut(`stalled: the Developer at ${this.config.developerUrl} stopped answering`);
        else if (idle >= stall) cut(`stalled: Ollama at ${this.config.ollamaUrl} holds no model while the call waits (nothing is working on it)`);
        else if (s && (busy === false || !dev)) s.trace.push({ step: 'watch', detail: busy === false ? 'Ollama holds no model yet' : 'the Developer does not answer' });
      })();
    }, every);
    try {
      return await call(ctl.signal);
    } catch (e) {
      if (ctl.signal.aborted) throw new StallError(why);
      throw e;
    } finally {
      clearTimeout(timer);
      clearInterval(probe);
    }
  }

  /** The step that is running now (where a retry is written). */
  private runningStep(): Step | undefined {
    for (const st of this.run.stages) for (const s of st.steps) if (s.status === 'running') return s;
    return undefined;
  }


  /** Claude Code in print mode with the Nuclear MCP server: each tool it calls becomes a step (the local developer's
   * calls are drawn as the coder's), its text is the step's log. The answer's text is returned. */
  private async claude(stage: Stage, parent: Step, prompt: string, tools: string[]): Promise<string> {
    const mcp = path.join(os.tmpdir(), `nuclear-loop-mcp-${process.pid}.json`);
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { nuclear: { command: this.config.graphCommand, args: ['mcp'] } } }));
    // --tools: the only built-in tools it has (no Bash); --allowedTools: the ones it may use without asking
    const builtIn = tools.filter((t) => !t.startsWith('mcp__'));
    const left = this.config.claudeBudgetUsd > 0 ? Math.max(0.05, this.config.claudeBudgetUsd - this.run.costUsd) : 0;
    const args = ['-p', prompt, '--model', this.config.claudeModel, '--output-format', 'stream-json', '--verbose', '--mcp-config', mcp, '--strict-mcp-config', '--tools', ...(builtIn.length ? builtIn : ['']), '--allowedTools', ...tools, '--no-session-persistence', ...(left ? ['--max-budget-usd', left.toFixed(2)] : [])];
    const p = spawn(this.config.claudeCommand || 'claude', args, { cwd: this.run.root, env: toolEnv() });
    this.children.push(p);
    let buffer = '';
    let answer = '';
    const calls = new Map<string, Step>();
    p.stdout.on('data', (d) => {
      buffer += String(d);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let ev: any;
        try {
          ev = JSON.parse(line);
        } catch {
          continue;
        }
        if (ev.type === 'assistant') {
          for (const c of ev.message?.content ?? []) {
            if (c.type === 'text') {
              parent.log += c.text + '\n';
              answer = c.text;
            }
            if (c.type === 'tool_use') {
              const name = String(c.name).replace(/^mcp__nuclear__/, '');
              const actor: Actor = name.startsWith('developer_code') ? 'coder' : name.startsWith('developer_test') ? 'tester' : name.startsWith('developer_security') ? 'security' : name.startsWith('graph_') ? 'graph' : 'claude';
              calls.set(c.id, this.step(stage, `${name}`, actor, { tool: name, input: JSON.stringify(c.input, null, 2).slice(0, 4000) }));
            }
          }
        }
        if (ev.type === 'user') {
          for (const c of ev.message?.content ?? []) {
            const s = c.type === 'tool_result' ? calls.get(c.tool_use_id) : undefined;
            if (!s) continue;
            const text = Array.isArray(c.content) ? c.content.map((x: any) => x.text ?? '').join('\n') : String(c.content ?? '');
            s.log = text.slice(0, 20000);
            this.end(s, c.is_error ? 'failed' : 'passed', lastLine(text) || 'done');
          }
        }
        if (ev.type === 'result') {
          this.run.costUsd += Number(ev.total_cost_usd ?? 0);
          answer = String(ev.result ?? answer);
        }
        this.emit('change', this.run);
      }
    });
    p.stderr.on('data', (d) => (parent.log += String(d)));
    await new Promise<void>((resolve) => {
      p.on('error', (e) => {
        parent.log += `claude could not start: ${e.message} (install Claude Code, or choose "Local only")\n`;
        resolve();
      });
      p.on('close', () => resolve());
    });
    fs.rmSync(mcp, { force: true });
    return answer;
  }
}

// ---------- CI ----------

export type CiProvider = 'github' | 'gitlab' | 'bitbucket';

const INSTALL = 'curl -fsSL https://raw.githubusercontent.com/nuclearlang/nuclear/main/tools/release/install.sh | sh && echo "$HOME/.local/bin" >> "${GITHUB_PATH:-/dev/null}"';

/** The deterministic stages of the pipeline for a server: the same commands of `.nuclear/loop.json`. The agent
 * stages (plan, code, the agents' tests and reviews) run on the developer's machine; the server checks their result. */
export const CI_STAGES = ['check', 'test', 'security', 'artifacts', 'deploy'] as const;
export type CiStage = (typeof CI_STAGES)[number];

/** The commands of each server stage (what `nuclear-loop ci` and the exported files run). */
export function ciCommands(c: LoopConfig['commands']): Record<CiStage, string[]> {
  return {
    check: c.check,
    test: [...c.build, ...c.test],
    security: c.security.length ? c.security : c.check,
    artifacts: c.artifacts,
    deploy: [...c.seed, ...c.integration, ...c.deploy],
  };
}

export function ciFile(provider: CiProvider, config: LoopConfig, platform: string): { path: string; text: string } {
  const stages = ciCommands(config.commands);
  const jobs: [string, string[]][] = CI_STAGES.map((s) => [s, stages[s]]);
  const run = (cmds: string[]) => cmds.map((x) => `export PATH="$HOME/.local/bin:$PATH" && ${x}`);
  const flutter = platform === 'mobile';
  if (provider === 'github') {
    const out = ['# Generated by the Nuclear Loop (.nuclear/loop.json). The agent stages run locally; this checks their result.', 'name: nuclear-loop', 'on:', '  push:', `    branches: [${config.branches.map((b) => `"${b}"`).join(', ')}]`, '  pull_request:', 'jobs:'];
    let prev = '';
    for (const [name, cmds] of jobs) {
      if (!cmds.length) continue;
      out.push(`  ${name}:`, '    runs-on: ubuntu-latest');
      if (prev) out.push(`    needs: ${prev}`);
      out.push('    steps:', '      - uses: actions/checkout@v4');
      if (flutter) out.push('      - uses: subosito/flutter-action@v2', '        with: { channel: stable }');
      out.push('      - name: Install NuclearLang', `        run: ${INSTALL}`);
      for (const cmd of run(cmds)) out.push(`      - run: ${cmd}`);
      if (name === 'artifacts') out.push('      - uses: actions/upload-artifact@v4', '        with: { name: build, path: build/ }');
      prev = name;
    }
    return { path: '.github/workflows/nuclear-loop.yml', text: out.join('\n') + '\n' };
  }
  if (provider === 'gitlab') {
    const used = jobs.filter(([, cmds]) => cmds.length);
    const out = ['# Generated by the Nuclear Loop (.nuclear/loop.json).', `stages: [${used.map(([n]) => n).join(', ')}]`, `image: ${flutter ? 'ghcr.io/cirruslabs/flutter:stable' : 'ubuntu:24.04'}`, 'default:', '  before_script:', '    - apt-get update -qq && apt-get install -y -qq curl git python3 python3-venv nodejs npm > /dev/null || true', `    - ${INSTALL.replace(' && echo "$HOME/.local/bin" >> "${GITHUB_PATH:-/dev/null}"', '')}`, ''];
    for (const [name, cmds] of used) {
      out.push(`${name}:`, `  stage: ${name}`, '  script:', ...run(cmds).map((x) => `    - ${x}`));
      if (name === 'artifacts') out.push('  artifacts:', '    paths: [build/]');
      out.push('');
    }
    return { path: '.gitlab-ci.yml', text: out.join('\n') };
  }
  const out = ['# Generated by the Nuclear Loop (.nuclear/loop.json).', `image: ${flutter ? 'ghcr.io/cirruslabs/flutter:stable' : 'ubuntu:24.04'}`, 'pipelines:', '  default:'];
  for (const [name, cmds] of jobs) {
    if (!cmds.length) continue;
    out.push('    - step:', `        name: ${name}`, '        script:', '          - apt-get update -qq && apt-get install -y -qq curl git python3 python3-venv nodejs npm > /dev/null || true', `          - ${INSTALL.replace(' && echo "$HOME/.local/bin" >> "${GITHUB_PATH:-/dev/null}"', '')}`, ...run(cmds).map((x) => `          - ${x}`));
    if (name === 'artifacts') out.push('        artifacts:', '          - build/**');
  }
  return { path: 'bitbucket-pipelines.yml', text: out.join('\n') + '\n' };
}

// ---------- helpers ----------

export function parsePieces(text: string): Piece[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try {
    const list = JSON.parse(text.slice(start, end + 1)) as Piece[];
    return list.filter((p) => p && typeof p.path === 'string' && p.path.endsWith('.nuc') && typeof p.task === 'string').map((p) => ({ path: p.path, kind: String(p.kind ?? ''), task: p.task }));
  } catch {
    return [];
  }
}

function fence(text: string): string {
  const m = text.match(/```(?:nuclear)?\n([\s\S]*?)```/);
  return m ? m[1] : '';
}

function lastLine(text: string): string {
  // `nuclear check --json` prints JSON arrays: the first error and how many there are
  const errors = [...text.matchAll(/^\[\n[\s\S]*?\n\]$/gm)].flatMap((m) => {
    try {
      return (JSON.parse(m[0]) as { severity?: string; file?: string; line?: number; code?: string; message?: string }[]).filter((d) => d.severity === 'error');
    } catch {
      return [];
    }
  });
  if (errors.length) {
    const d = errors[0];
    return `${errors.length} error(s), first ${d.file ?? ''}:${d.line ?? ''} ${d.code ?? ''} ${d.message ?? ''}`.slice(0, 200);
  }
  const lines = text.trim().split('\n');
  // the compiler's own words (`error[N0116]: ...`, and under it ` --> file:line:col`): the first error, not the
  // caret under its last one
  const told = lines.filter((l) => /^error\b/.test(l));
  if (told.length) {
    const at = lines[lines.indexOf(told[0]) + 1]?.match(/-->\s*(\S+)/)?.[1];
    return `${told.length} error(s), first ${at ? at + ' ' : ''}${told[0]}`.slice(0, 240);
  }
  return (lines[lines.length - 1] ?? '').slice(0, 200);
}

function pascal(name: string): string {
  return name.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function copyTree(from: string, to: string, skip: string[]): number {
  if (!fs.existsSync(from)) return 0;
  let n = 0;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip.includes(e.name)) continue;
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) n += copyTree(a, b, skip);
    else if (e.isFile()) {
      fs.copyFileSync(a, b);
      n += 1;
    }
  }
  return n;
}
