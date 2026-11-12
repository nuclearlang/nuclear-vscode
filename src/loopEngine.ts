// The Nuclear Loop engine (ADR-0102): a spec goes through the pipeline spec → plan → code → test → security →
// artifacts → deploy on the developer's machine, and every step says who does it (you, Claude, a local agent, the
// shell) and what it did. A frontier model (Claude) plans and reviews; the local developer (Nuclear Developer, a 3B
// model fed by the Nuclear Smart Graph) writes each piece; the shell runs the project's own commands, the same ones the
// exported CI runs on a server. No VS Code here: the panel (loopPanel.ts) draws what this module emits, and a node
// script can drive it alone.
import { ChildProcess, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { atomicWrite, BEAT_MS, checkConnections, ollamaBusy, orphaned, owner, Owner, rollback, trace, Write } from './loopSafety';
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
  /** Why the run failed, told by the local diagnoser (`/developer/diagnose`): kind, action and explanation. */
  diagnosis?: string;
  /** The earlier attempts of a run retried from a stage: their stages as they ended. */
  previous?: { at: number; from: StageId; status: Status; stages: Stage[] }[];
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

const STAGES: Omit<Stage, 'status' | 'steps'>[] = [
  { id: 'spec', title: 'Specification', about: 'The spec you wrote or imported, with its acceptance criteria and the context the agents get. Written to specs/<id>/spec.md.', actors: ['you'] },
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
    coderModel: 'qwen2.5-coder:3b',
    assistantModel: 'gemma4:e2b',
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
    spec,
    status: 'pending',
    created: Date.now(),
    stages: STAGES.map((s) => ({ ...s, status: 'pending', steps: [] })),
    costUsd: 0,
  };
}

export function listRuns(root: string): Run[] {
  const dir = path.join(root, RUNS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Run;
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
  lines.push(...(spec.criteria.length ? spec.criteria.map((c) => `- [ ] ${c}`) : ['- (none yet)']));
  if (spec.context.length) lines.push('', '## Context', '', ...spec.context.map((c) => `- ${c}`));
  if (spec.resources?.length) lines.push('', '## Resources', '', ...spec.resources.map((r) => `- \`${r}\``));
  if (spec.pieces.length) lines.push('', '## Pieces', '', ...spec.pieces.map((p) => `- \`${p.path}\` (${p.kind}): ${p.task}`));
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
  ];
  if (run.notes) out.push('', '## What the local developer says', '', run.notes);
  if (run.diagnosis) out.push('', '## Why it failed (local diagnoser)', '', run.diagnosis);
  for (const p of run.previous ?? []) out.push('', `- Retried from ${p.from} at ${when(p.at)} (the earlier attempt ${p.status}; kept in the run's .json)`);
  for (const i of run.interrupted ?? []) out.push('', `- Interrupted at ${i.stage}${i.step ? ` · ${i.step}` : ''} (${when(i.at)}): the process that ran it stopped; undone: ${i.undone.join(', ') || 'nothing'}; the trace log is ${RUNS_DIR}/${run.id}.log`);
  const files = run.stages.flatMap((st) => st.steps.filter((s) => s.file?.endsWith('.nuc') && s.code).map((s) => `- \`${s.file}\` (${s.actor}, ${s.status})`));
  if (files.length) out.push('', '## Files written', '', ...[...new Set(files)]);
  const open = run.stages.flatMap((st) => st.steps.filter((s) => s.status === 'failed').map((s) => `- ${st.title} · ${s.title}: ${s.summary}`));
  if (open.length) out.push('', '## Left for the reviewer', '', ...open);
  for (const st of run.stages) {
    out.push('', `## ${st.title} — ${st.status}`);
    for (const s of st.steps) {
      out.push('', `### ${s.title} (${s.actor}, ${s.status})`, '');
      if (s.summary) out.push(s.summary, '');
      if (s.file) out.push(`File: \`${s.file}\``, '');
      if (s.tool) out.push(`Tool: \`${s.tool}\``, '');
      if (s.trace.length) out.push(...s.trace.map((t) => `1. **${t.step}**: ${t.detail.replace(/\s+/g, ' ').slice(0, 300)}`), '');
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
    (this.run.writes ??= []).push({ path: rel, step: s.id, before, at: Date.now() });
    this.save(); // the ledger first: a crash after the write can still undo it
    atomicWrite(file, text);
    this.log('write', undefined, s, rel);
  }

  private stage(id: StageId): Stage {
    return this.run.stages.find((s) => s.id === id)!;
  }

  private step(stage: Stage, title: string, actor: Actor, extra: Partial<Step> = {}): Step {
    const s: Step = { id: `${stage.id}-${stage.steps.length + 1}`, title, actor, status: 'running', started: Date.now(), summary: '', log: '', trace: [], ...extra };
    stage.steps.push(s);
    this.save();
    this.log('step', stage, s, title);
    return s;
  }

  private end(s: Step, status: Status, summary: string): void {
    s.status = status;
    s.summary = summary;
    s.ended = Date.now();
    this.save();
    this.log(status, undefined, s, summary.slice(0, 200));
  }

  /** Runs the pipeline. A failed run is retried from `from` (default: the first stage that failed): the stages before
   * it are kept as they passed and the earlier attempt is kept in `previous`. With `step`, the retry goes on from the
   * step that failed: the steps of that stage that passed are kept too (the pieces already written, the reviews
   * done), so only what failed runs again. */
  async start(from?: StageId, step = false): Promise<Run> {
    // one process at a time: a run another window is running (its heartbeat is fresh) is not started twice
    if (this.run.status === 'running' && this.run.owner && this.run.owner.pid !== process.pid && !orphaned(this.run.owner)) {
      throw new Error(`the run '${this.run.id}' is running in another process (pid ${this.run.owner.pid}); stop it there first`);
    }
    if (this.run.status === 'running') recoverRun(this.run); // orphaned: undo what it left half done, then go on
    const ids = this.run.stages.map((st) => st.id);
    const first = from ?? this.run.stages.find((st) => st.status === 'failed')?.id;
    const resume = first && this.run.stages.some((st) => st.status !== 'pending') ? ids.indexOf(first) : -1;
    if (resume >= 0) {
      this.run.previous = [...(this.run.previous ?? []), { at: Date.now(), from: first!, status: this.run.status, stages: structuredClone(this.run.stages.slice(resume)) }];
      for (const [i, st] of this.run.stages.slice(resume).entries()) {
        const keep = step && i === 0 ? st.steps.filter((x) => x.status === 'passed') : [];
        Object.assign(st, { status: 'pending', steps: keep, started: undefined, ended: undefined });
      }
      this.run.notes = undefined;
      this.run.diagnosis = undefined;
      this.run.ended = undefined;
      this.restoreWritten();
    }
    this.run.status = 'running';
    this.run.owner = owner();
    this.save();
    this.log(resume >= 0 ? 'resume' : 'start', undefined, undefined, resume >= 0 ? `from ${first}${step ? ' (the failed step)' : ''}` : this.run.spec.title);
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
    return spec.criteria.length > 0;
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
    const resources = specResources(this.run.spec, this.run.platform);
    if (!resources.length) {
      this.end(this.step(stage, 'Nothing to generate', 'shell'), 'skipped', 'the spec names no resource (a GET <url> line or a Resources section)');
      return true;
    }
    const specFile = path.join(SPECS_DIR, this.run.spec.id, 'spec.md');
    for (const resource of resources) {
      if (this.stopped) return false;
      const words = resource.match(/"[^"]*"|\S+/g) ?? [];
      const args = ['gen', 'resource', ...words];
      if (!words.some((w) => w === '--from-json' || w === '--from-spec' || w === '--fields')) args.push('--from-spec', specFile);
      const command = ['dragonfly', ...args.map((a) => (/^[\w./:,=-]+$/.test(a) ? a : `'${a.replace(/^"|"$/g, '').replace(/'/g, "'\\''")}'`))].join(' ');
      const before = nucFiles(this.run.root);
      const s = this.step(stage, command, 'shell', { input: command });
      const code = await shell(command, this.run.root, (d) => {
        s.log = (s.log + d).slice(-60000);
        this.emit('change', this.run);
      }, (p) => this.children.push(p), this.config.commandTimeoutMs);
      // what it wrote goes to the ledger, so a crash or a failed run undoes it like an agent's file
      const after = nucFiles(this.run.root);
      const changed = [...after].filter(([f, t]) => before.get(f) !== t).map(([f]) => f);
      for (const f of changed) (this.run.writes ??= []).push({ path: f, step: s.id, before: before.get(f) ?? null, at: Date.now() });
      s.files = changed;
      this.save();
      this.end(s, code === 0 ? 'passed' : 'failed', code === 0 ? `${changed.length} files` : `exit ${code}: ${lastLine(s.log)}`);
      if (code !== 0) return false;
    }
    // the project map the planner and the tester read, with what was generated
    return this.commands(stage, ['nuclear check .'], false);
  }

  // plan: the pieces

  private async planStage(): Promise<boolean> {
    const stage = this.stage('plan');
    if (this.kept(stage, 'planner') && this.run.spec.pieces.length) return true;
    if (this.run.spec.pieces.length) {
      const s = this.step(stage, 'Pieces from the spec', 'you');
      s.log = this.run.spec.pieces.map((p) => `${p.path} | ${p.kind} | ${p.task}`).join('\n');
      this.end(s, 'passed', `${this.run.spec.pieces.length} pieces written in the form`);
      return true;
    }
    if (this.run.spec.lead === 'claude') {
      const s = this.step(stage, 'Claude splits the spec into pieces', 'claude');
      const prompt = `${this.specPrompt()}${this.generatedNote()}\n\n## Context\n\n${this.contextText()}\n\nThe project is \`${this.run.project}\` (platform ${this.run.platform}, dialect ${this.run.dialect}), in the current folder. First call graph_prompt("plan") and follow it; read the project's files you need. Then answer ONLY a JSON array of pieces: [{"path": "...", "kind": "...", "task": "..."}], each task complete enough for a junior who sees nothing else (names, signatures, the files it uses).`;
      const text = await this.claude(stage, s, prompt, ['Read', 'Glob', 'Grep', 'mcp__nuclear__graph_search', 'mcp__nuclear__graph_prompt', 'mcp__nuclear__nuclear_help', 'mcp__nuclear__nuclear_brief']);
      const pieces = this.withoutGenerated(parsePieces(text));
      this.run.spec.pieces = pieces;
      const done = pieces.length > 0 || this.generated().length > 0;
      this.end(s, done ? 'passed' : 'failed', pieces.length || done ? `${pieces.length} pieces` : 'no pieces in the answer');
      return done;
    }
    const s = this.step(stage, 'The local planner splits the spec', 'planner');
    const r = await this.developer('/developer/plan', { spec: `${this.specPrompt()}${this.generatedNote()}\n\n${this.contextText().slice(0, 4000)}`, platform: this.run.platform });
    if (!r.ok) {
      this.end(s, 'failed', r.error);
      return false;
    }
    s.trace = r.data.trace ?? [];
    s.log = String(r.data.raw ?? '');
    this.run.spec.pieces = this.withoutGenerated((r.data.pieces ?? []) as Piece[]);
    const done = this.run.spec.pieces.length > 0 || this.generated().length > 0;
    this.end(s, done ? 'passed' : 'failed', `${this.run.spec.pieces.length} pieces${this.generated().length ? ` (besides ${this.generated().length} generated files)` : ''}`);
    return done;
  }

  /** What the planner reads about the generated files: they are done, plan only what is left. */
  private generatedNote(): string {
    const files = this.generated();
    return files.length ? `\n\n## Already generated (done and compiling: do not plan them again)\n\n${files.map((f) => `- ${f}`).join('\n')}\n\nPlan only what these do not do (a use case with its own rules, a view's details); plan nothing when they do everything.` : '';
  }

  /** A planned piece the generators already wrote (the same file, or the same declaration elsewhere) is dropped. */
  private withoutGenerated(pieces: Piece[]): Piece[] {
    const files = this.generated();
    const stems = new Set(files.map((f) => path.basename(f, '.nuc')));
    return pieces.filter((p) => !files.includes(p.path) && !stems.has(path.basename(p.path, '.nuc')));
  }

  // code: each piece by the local coder, Claude for what it cannot, then the project's check

  private async codeStage(): Promise<boolean> {
    const stage = this.stage('code');
    for (const piece of this.run.spec.pieces) {
      if (this.stopped) return false;
      if (this.kept(stage, 'coder', piece.path) && fs.existsSync(path.join(this.run.root, piece.path))) continue; // written before the retry
      const target = path.join(this.run.root, piece.path);
      const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
      const s = this.step(stage, piece.path, 'coder', { file: piece.path, input: piece.task });
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
        this.end(s, ok ? 'passed' : 'failed', ok ? `ok in ${r.data.attempts} attempt(s)` : String(r.data.check).split('\n')[0]);
      }
      if (!ok) return false;
      this.writeFile(piece.path, s.code ?? '', s);
      this.written.push({ path: piece.path, code: s.code ?? '', kind: piece.kind });
    }
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
      if (await this.commands(stage, run, true)) return true;
      const failed = [...stage.steps].reverse().find((x) => x.actor === 'shell' && x.status === 'skipped');
      const told = await this.explain(failed?.log ?? '');
      if (failed) failed.agent = told.text;
      const files = told.files.filter((f) => this.written.some((w) => w.path === f));
      // no frame in a file of the run: every piece the failure names, else every piece
      const targets = files.length ? files : this.written.filter((w) => told.text.includes(path.basename(w.path, '.nuc'))).map((w) => w.path);
      for (const file of targets.length ? targets : this.written.map((w) => w.path)) {
        await this.repairWith(stage, file, `The project's tests fail (round ${round}). Fix this file so they pass; the tests say what the code must do (change a test only if it contradicts the spec).\n\n${told.text}`);
      }
    }
    if (this.run.spec.lead === 'claude') {
      const left = [...stage.steps].reverse().find((x) => x.actor === 'shell' && x.status === 'skipped');
      const fix = this.step(stage, 'Claude fixes the failing tests', 'claude');
      await this.claude(stage, fix, `The project's tests still fail after the local developer's repairs:\n\n${left?.agent ?? left?.log ?? ''}\n\nFix the .nuc files (never build/), then run nuclear_check with path "${this.run.root}" and keep each fix a junior could learn with graph_remember (collection "examples").`, ['Read', 'Edit', 'Write', 'mcp__nuclear__nuclear_check', 'mcp__nuclear__nuclear_help', 'mcp__nuclear__graph_search', 'mcp__nuclear__graph_remember']);
      this.end(fix, 'passed', 'done');
    }
    return this.commands(stage, run);
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
  private async developer(route: string, body: unknown, step?: Step): Promise<{ ok: true; data: Record<string, any> } | { ok: false; error: string }> {
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
