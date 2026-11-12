// What keeps a Loop run safe when something breaks (ADR-0102 §21): the run's state is written atomically, every event
// goes to an append-only trace log (`.nuclear/loop/runs/<id>.log`), the process that runs it beats every few seconds,
// every file it writes is kept in a ledger with what was there before, and the services it needs are checked before
// it starts. A run whose owner stopped (the editor was closed or crashed) is recognised from its stale heartbeat,
// what it left incomplete is undone, and it goes on from the step where it stopped. No VS Code import: the CLI and the
// tests use it too.
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** How often the process that runs a run says it is alive, and after how long without it the run is orphaned. */
export const BEAT_MS = 10_000;
export const STALE_MS = 45_000;

/** Writes a file so a reader never sees half of it: a temporary file in the same folder, then a rename. */
export function atomicWrite(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** One line of the trace log: when, what happened and where. */
export interface TraceEvent {
  at: number;
  event: string;
  stage?: string;
  step?: string;
  detail?: string;
}

/** Appends an event to the run's trace log (JSON lines: it survives a crash, the last complete line is the last event). */
export function trace(file: string, e: Omit<TraceEvent, 'at'>): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ at: Date.now(), ...e }) + '\n');
  } catch {
    // the trace never stops a run: a full disk is caught by the preflight
  }
}

export function readTrace(file: string): TraceEvent[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((l) => {
        try {
          return l ? [JSON.parse(l) as TraceEvent] : [];
        } catch {
          return []; // a line cut by the crash
        }
      });
  } catch {
    return [];
  }
}

/** Who runs a run: the process, its machine and its last heartbeat. */
export interface Owner {
  pid: number;
  host: string;
  beat: number;
}

export function owner(): Owner {
  return { pid: process.pid, host: os.hostname(), beat: Date.now() };
}

/** Whether a process of this machine still lives (signal 0 asks without touching it). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A run said to be running whose owner is gone: no beat for STALE_MS, or its process is dead on this machine. */
export function orphaned(o: Owner | undefined, now = Date.now()): boolean {
  if (!o) return true;
  if (now - o.beat > STALE_MS) return true;
  return o.host === os.hostname() && o.pid !== process.pid && !alive(o.pid);
}

/** A file a run wrote, and what was there before (`null`: it did not exist), to undo what a broken step left. */
export interface Write {
  path: string;
  step: string;
  before: string | null;
  at: number;
}

/** Undoes the writes of the steps that did not pass (newest first): their files go back to what they were. */
export function rollback(root: string, writes: Write[], passed: (step: string) => boolean): string[] {
  const undone: string[] = [];
  for (const w of [...writes].reverse()) {
    if (passed(w.step)) continue;
    const file = path.join(root, w.path);
    if (w.before === null) fs.rmSync(file, { force: true });
    else atomicWrite(file, w.before);
    undone.push(w.path);
  }
  return undone;
}

// ---------- the services a task needs ----------

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Needs {
  developerUrl: string;
  graphUrl: string;
  ollamaUrl: string;
  /** The local models that must be installed in Ollama. */
  models: string[];
  /** Command line tools that must answer `--version` (`claude` when Claude leads). */
  tools: string[];
  /** Folders that need free space (the project, the temporary folder), at least `minFreeMb` each. */
  folders: string[];
  minFreeMb: number;
}

async function get(url: string, ms = 3000): Promise<{ ok: boolean; status: number; body: string; error?: string }> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return { ok: r.ok, status: r.status, body: await r.text() };
  } catch (e) {
    return { ok: false, status: 0, body: '', error: e instanceof Error ? e.message : String(e) };
  }
}

function version(cmd: string, env: NodeJS.ProcessEnv): Promise<Check> {
  return new Promise((resolve) => {
    execFile(cmd, ['--version'], { timeout: 15000, env }, (e, out, err) =>
      resolve({ name: cmd, ok: !e, detail: e ? `${cmd} does not answer (${e.message.split('\n')[0]})` : `${(out || err).trim().split('\n')[0]}` }),
    );
  });
}

/** Free space of the volume that holds a folder, in megabytes. */
export function freeMb(folder: string): number {
  const s = fs.statfsSync(folder);
  return Math.floor((s.bavail * s.bsize) / 1024 / 1024);
}

/** Every service a task will use, checked now: each answers, the models are installed, the disks have room. */
export async function checkConnections(n: Needs, env: NodeJS.ProcessEnv = process.env): Promise<Check[]> {
  const [dev, graph, tags] = await Promise.all([get(n.developerUrl + '/docs'), get(n.graphUrl + '/v1/health'), get(n.ollamaUrl + '/api/tags')]);
  const out: Check[] = [
    { name: 'Nuclear Developer', ok: dev.ok, detail: dev.ok ? n.developerUrl : `${n.developerUrl} does not answer (${dev.error ?? dev.status}): start it in Settings and integrations` },
    { name: 'Smart Graph', ok: graph.ok, detail: graph.ok ? n.graphUrl : `${n.graphUrl} does not answer (${graph.error ?? graph.status}): nuclear-graph serve` },
    { name: 'Ollama', ok: tags.ok, detail: tags.ok ? n.ollamaUrl : `${n.ollamaUrl} does not answer (${tags.error ?? tags.status}): start Ollama` },
  ];
  if (tags.ok) {
    let installed: string[] = [];
    try {
      installed = (JSON.parse(tags.body) as { models: { name: string }[] }).models.map((m) => m.name);
    } catch {
      installed = [];
    }
    for (const m of n.models) {
      const has = installed.some((i) => i === m || i === `${m}:latest`);
      out.push({ name: `model ${m}`, ok: has, detail: has ? 'installed' : `not installed: ollama pull ${m} (or Pull in Settings and integrations)` });
    }
  }
  out.push(...(await Promise.all(n.tools.map((t) => version(t, env)))));
  for (const f of n.folders) {
    try {
      const mb = freeMb(f);
      out.push({ name: `disk ${f}`, ok: mb >= n.minFreeMb, detail: `${mb} MB free${mb >= n.minFreeMb ? '' : ` (at least ${n.minFreeMb} MB are needed: free some space)`}` });
    } catch {
      // a folder that does not exist yet has nothing to fill
    }
  }
  return out;
}

/** Whether a model is working for a request that waits: Ollama lists the models it holds in memory (`/api/ps`). */
export async function ollamaBusy(ollamaUrl: string): Promise<boolean | undefined> {
  const r = await get(ollamaUrl + '/api/ps', 2500);
  if (!r.ok) return undefined;
  try {
    return (JSON.parse(r.body) as { models?: unknown[] }).models?.length !== 0;
  } catch {
    return undefined;
  }
}
