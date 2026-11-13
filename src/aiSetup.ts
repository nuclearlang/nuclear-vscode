// The set-up of the AI services (ADR-0106): what this machine has, what each profile needs and how far it works, and
// the steps that install it. No editor here: the wizard (setupPanel.ts) and `nuclear-loop setup` (loopCli.ts) are two
// fronts of this file. The requirements and the profiles are data (aiSetup.json).
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import setup from './aiSetup.json';
import { toolEnv } from './loopEngine';

/** A set of local models (or none: `remote`), what it downloads, the memory it wants and how far it works. */
export interface Profile {
  id: string;
  title: string;
  summary: string;
  coder?: string;
  assistant?: string;
  /** What it downloads, in GB (the models, with the embeddings). */
  gb: number;
  /** The memory of a machine it runs well on, and the least it loads with, in GB. */
  ram: number;
  minRam: number;
  /** What the Developer's evaluation gave with these models, or that it was not run yet. */
  measured: string;
  works: string[];
  limits: string[];
}

/** A program the services need: found by its command, installed by the command of this system (in a terminal the
 * user sees) or by hand from its page. */
export interface Requirement {
  id: string;
  title: string;
  why: string;
  command: string;
  url: string;
  /** Only the local profiles need it. */
  local?: boolean;
  install: Record<string, string | undefined>;
  note?: Record<string, string | undefined>;
}

export const PROFILES: Profile[] = setup.profiles;
export const REQUIREMENTS: Requirement[] = setup.requirements;
export const EMBEDDINGS: string = setup.embeddings;
export const profileOf = (id: string): Profile | undefined => PROFILES.find((p) => p.id === id);

// ---------- where things are ----------

export function installDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.NUCLEAR_INSTALL || (process.platform === 'win32' ? path.join(env.LOCALAPPDATA ?? os.homedir(), 'nuclearlang') : path.join(os.homedir(), '.local', 'share', 'nuclearlang'));
}

export function binDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.NUCLEAR_BIN || (process.platform === 'win32' ? path.join(installDir(env), 'bin') : path.join(os.homedir(), '.local', 'bin'));
}

/** The folder with the code of the services (`nuclear-graph/`, `nuclear-developer/` and its knowledge base), as the
 * installers leave it; undefined when NuclearLang is not installed. */
export function aiRoot(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const root = env.NUCLEAR_AI_ROOT || path.join(installDir(env), 'ai');
  return fs.existsSync(path.join(root, 'nuclear-graph', 'pyproject.toml')) && fs.existsSync(path.join(root, 'nuclear-developer', 'config.nuc')) ? root : undefined;
}

/** What the set-up chose on this machine (`KEY=value` lines): the mode, the profile and its models. The services
 * start with it, `nuclear-loop` and the editor take their defaults from it. */
export function machineFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = process.platform === 'win32' ? (env.APPDATA ?? os.homedir()) : env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'nuclearlang', 'ai.env');
}

export function readMachine(file = machineFile()): Record<string, string> {
  try {
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l));
    return Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
  } catch {
    return {};
  }
}

export function writeMachine(values: Record<string, string>, file = machineFile()): void {
  const all = { ...readMachine(file), ...values };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const head = '# The AI services of NuclearLang on this machine, written by their set-up (nuclear-loop setup, the editor).\n';
  fs.writeFileSync(file, head + Object.entries(all).map(([k, v]) => `${k}=${v}\n`).join(''));
}

/** What a profile writes in the machine's file. */
export function machineOf(p: Profile): Record<string, string> {
  return p.coder
    ? { NUCLEAR_AI_MODE: 'local', NUCLEAR_AI_PROFILE: p.id, CODER_MODEL: p.coder, ASSISTANT_MODEL: p.assistant ?? p.coder, NUCLEAR_GRAPH_EMBED: EMBEDDINGS }
    : { NUCLEAR_AI_MODE: 'remote', NUCLEAR_AI_PROFILE: p.id };
}

// ---------- the machine ----------

export interface Hardware {
  platform: NodeJS.Platform;
  arch: string;
  cpu: string;
  cores: number;
  /** Memory, the GPU's own memory (0: none known; Ollama then uses the integrated GPU or the CPU) and free disk of
   * the home, in GB. */
  ram: number;
  gpu: string;
  vram: number;
  disk: number;
}

function capture(cmd: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => execFile(cmd, args, { cwd, timeout: 20000, env: toolEnv() }, (e, out, err) => resolve({ code: e ? 1 : 0, out: `${out}${err}` })));
}

export async function hardware(): Promise<Hardware> {
  const gb = (bytes: number) => Math.round(bytes / 1e9);
  const cpus = os.cpus();
  let gpu = '';
  let vram = 0;
  const smi = await capture('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  const [name, mib] = smi.out.trim().split('\n')[0].split(',').map((s) => s.trim());
  if (smi.code === 0 && Number(mib) > 0) {
    gpu = name;
    vram = Math.round(Number(mib) / 1024);
  } else if (process.platform === 'darwin' && os.arch() === 'arm64') {
    gpu = 'Apple silicon (memory shared with the GPU)';
    vram = gb(os.totalmem());
  }
  let disk = 0;
  try {
    const s = fs.statfsSync(os.homedir());
    disk = gb(s.bavail * s.bsize);
  } catch {
    disk = 0; // unknown: not held against a profile
  }
  return { platform: process.platform, arch: os.arch(), cpu: cpus[0]?.model.trim() ?? '', cores: cpus.length, ram: gb(os.totalmem()), gpu, vram, disk };
}

export type Fit = 'fits' | 'tight' | 'no';

/** How a profile sits on a machine, and why, in words for the user. */
export function fit(p: Profile, hw: Hardware): { fit: Fit; note: string } {
  if (!p.coder) return { fit: 'fits', note: 'nothing runs on this machine' };
  if (hw.disk && hw.disk < p.gb + 2) return { fit: 'no', note: `it downloads ${p.gb} GB and ${hw.disk} GB of disk are free` };
  if (hw.ram < p.minRam) return { fit: 'no', note: `its models do not load: it needs ${p.minRam} GB of memory, this machine has ${hw.ram} GB` };
  const where = hw.vram >= p.gb ? `the models fit in the GPU (${hw.gpu})` : 'no GPU with memory of its own was found: an answer takes from seconds to a few minutes';
  if (hw.ram < p.ram) return { fit: 'tight', note: `it runs with little else open (${p.ram} GB of memory recommended, this machine has ${hw.ram} GB); ${where}` };
  return { fit: 'fits', note: where };
}

/** The profile suggested for a machine: the heaviest local one that fits, else the lightest that still runs, else
 * the remote agents alone. The user decides. */
export function recommend(hw: Hardware, profiles: Profile[] = PROFILES): string {
  const local = profiles.filter((p) => p.coder);
  const best = [...local].reverse().find((p) => fit(p, hw).fit === 'fits') ?? local.find((p) => fit(p, hw).fit === 'tight');
  return best?.id ?? 'remote';
}

// ---------- what is installed ----------

function which(cmd: string): string | undefined {
  const env = toolEnv();
  const dirs = (env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'] ?? '').split(path.delimiter);
  const names = process.platform === 'win32' ? [`${cmd}.exe`, `${cmd}.cmd`, cmd] : [cmd];
  for (const d of dirs) for (const n of names) if (d && fs.existsSync(path.join(d, n))) return path.join(d, n);
  return undefined;
}

async function up(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2500) })).status < 500;
  } catch {
    return false;
  }
}

export interface Urls {
  graph: string;
  developer: string;
  ollama: string;
}

export function urls(env: NodeJS.ProcessEnv = process.env): Urls {
  const m = readMachine();
  return {
    graph: env.NUCLEAR_GRAPH_URL || 'http://127.0.0.1:7878',
    developer: env.NUCLEAR_DEVELOPER_URL || 'http://127.0.0.1:7879',
    ollama: env.OLLAMA_URL || m.OLLAMA_URL || 'http://localhost:11434',
  };
}

export interface Found extends Requirement {
  found: boolean;
  detail: string;
}

/** The requirements of a mode, each found or not on this machine. */
export async function requirements(local: boolean, u: Urls = urls()): Promise<Found[]> {
  const out: Found[] = [];
  for (const r of REQUIREMENTS.filter((x) => local || !x.local)) {
    const at = which(r.command);
    if (r.id === 'nuclearlang') out.push({ ...r, found: !!at && !!aiRoot(), detail: !at ? 'not installed' : aiRoot() ? at : 'installed without the AI services: update it' });
    else if (r.id === 'ollama') {
      const answers = await up(u.ollama + '/api/tags');
      out.push({ ...r, found: answers, detail: answers ? u.ollama : at ? `installed, not running: start it (its app, or \`ollama serve\`)` : 'not installed' });
    } else out.push({ ...r, found: !!at, detail: at ?? 'not installed' });
  }
  return out;
}

export async function installedModels(ollamaUrl: string): Promise<string[]> {
  try {
    const r = await fetch(ollamaUrl + '/api/tags', { signal: AbortSignal.timeout(3000) });
    return ((await r.json()) as { models: { name: string }[] }).models.map((m) => m.name);
  } catch {
    return [];
  }
}

/** A model Ollama has: `embeddinggemma` is `embeddinggemma:latest` there. */
export const hasModel = (installed: string[], model: string): boolean => installed.includes(model) || installed.includes(`${model}:latest`);

export interface Status {
  machine: Record<string, string>;
  graph: boolean;
  developer: boolean;
  ollama: boolean;
  atLogin: boolean;
  missingModels: string[];
}

export async function status(u: Urls = urls()): Promise<Status> {
  const machine = readMachine();
  const [graph, developer, ollama, models] = await Promise.all([up(u.graph + '/v1/health'), up(u.developer + '/docs'), up(u.ollama + '/api/tags'), installedModels(u.ollama)]);
  const wanted = machine.NUCLEAR_AI_MODE === 'local' ? [machine.NUCLEAR_GRAPH_EMBED, machine.CODER_MODEL, machine.ASSISTANT_MODEL].filter(Boolean) : [];
  return { machine, graph, developer, ollama, atLogin: serviceFiles().every((f) => fs.existsSync(f.path)), missingModels: [...new Set(wanted)].filter((m) => !hasModel(models, m)) };
}

// ---------- the services at login ----------

export type ServiceName = 'graph' | 'developer';
const SERVICES: { name: ServiceName; title: string; args: string[] }[] = [
  { name: 'graph', title: 'Nuclear Smart Graph', args: ['nuclear-graph', 'serve'] },
  { name: 'developer', title: 'Nuclear Developer', args: ['nuclear-developer'] },
];
const label = (name: ServiceName) => `io.github.nuclearlang.${name}`;

/** The PATH a service runs with: where the NuclearLang tools are and the system's folders. Not the PATH of whoever
 * ran the set-up, which may put a project's own environment first. */
export function servicePath(bin = binDir(), home = os.homedir()): string {
  return [bin, path.join(home, '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':');
}

/** The files that start the services when the user logs in: systemd user units (Linux), launch agents (macOS), a
 * script of the Startup folder (Windows). They start with the machine's file as their environment. */
export function serviceFiles(platform: NodeJS.Platform = process.platform, home = os.homedir(), bin = binDir(), machine = machineFile(), pathEnv = servicePath(bin, home)): { path: string; text: string }[] {
  if (platform === 'linux') {
    return SERVICES.map((s) => ({
      path: path.join(home, '.config', 'systemd', 'user', `nuclear-${s.name}.service`),
      text: `[Unit]\nDescription=${s.title} (NuclearLang)\n${s.name === 'developer' ? 'After=nuclear-graph.service\n' : ''}\n[Service]\nEnvironment=PATH=${pathEnv}\nEnvironmentFile=-${machine}\nExecStart=${path.join(bin, s.args[0])}${s.args.slice(1).map((a) => ' ' + a).join('')}\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`,
    }));
  }
  if (platform === 'darwin') {
    return SERVICES.map((s) => ({
      path: path.join(home, 'Library', 'LaunchAgents', `${label(s.name)}.plist`),
      text: `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>${label(s.name)}</string>\n  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>set -a; [ -f '${machine}' ] &amp;&amp; . '${machine}'; exec '${path.join(bin, s.args[0])}'${s.args.slice(1).map((a) => ' ' + a).join('')}</string></array>\n  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${pathEnv}</string></dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>StandardErrorPath</key><string>${path.join(home, 'Library', 'Logs', `nuclear-${s.name}.log`)}</string>\n</dict></plist>\n`,
    }));
  }
  if (platform === 'win32') {
    const file = (cmd: string) => path.win32.join(bin, cmd + (cmd === 'nuclear-developer' ? '.cmd' : '.exe'));
    const start = SERVICES.map((s) => `start "" /min "${file(s.args[0])}"${s.args.slice(1).map((a) => ' ' + a).join('')}`).join('\r\n');
    return [{
      path: path.win32.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'nuclear-ai.cmd'),
      text: `@echo off\r\nrem The AI services of NuclearLang, started at login (written by their set-up).\r\nfor /f "usebackq eol=# tokens=1,* delims==" %%a in ("${machine}") do set "%%a=%%b"\r\n${start}\r\n`,
    }];
  }
  return [];
}

/** Whether this system starts user services by itself (Linux without a systemd user session does not). */
async function serviceManager(): Promise<boolean> {
  if (process.platform === 'linux') return (await capture('systemctl', ['--user', 'show-environment'])).code === 0;
  return process.platform === 'darwin' || process.platform === 'win32';
}

/** Starts a service again through the system's manager; false when the system keeps none (the caller starts it). */
export async function restartService(name: ServiceName): Promise<boolean> {
  const file = serviceFiles().find((f) => f.path.includes(name) || process.platform === 'win32');
  if (!file || !fs.existsSync(file.path) || !(await serviceManager())) return false;
  if (process.platform === 'linux') return (await capture('systemctl', ['--user', 'restart', `nuclear-${name}`])).code === 0;
  if (process.platform === 'darwin') return (await capture('launchctl', ['kickstart', '-k', `gui/${process.getuid?.()}/${label(name)}`])).code === 0;
  return false; // Windows: the Startup script starts them at login; now, the caller does
}

async function enableServices(say: Say): Promise<boolean> {
  const files = serviceFiles();
  if (!files.length || !(await serviceManager())) return false;
  for (const f of files) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.text);
    say(`wrote ${f.path}`);
  }
  if (process.platform === 'linux') {
    await run('systemctl', ['--user', 'daemon-reload'], say);
    await run('systemctl', ['--user', 'enable', ...SERVICES.map((s) => `nuclear-${s.name}`)], say);
  } else if (process.platform === 'darwin') {
    for (const [i, s] of SERVICES.entries()) {
      await capture('launchctl', ['bootout', `gui/${process.getuid?.()}/${label(s.name)}`]);
      await run('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, files[i].path], say);
    }
  }
  return true;
}

export async function removeServices(say: Say = () => undefined): Promise<void> {
  if (process.platform === 'linux') await capture('systemctl', ['--user', 'disable', '--now', ...SERVICES.map((s) => `nuclear-${s.name}`)]);
  if (process.platform === 'darwin') for (const s of SERVICES) await capture('launchctl', ['bootout', `gui/${process.getuid?.()}/${label(s.name)}`]);
  for (const f of serviceFiles()) {
    if (fs.existsSync(f.path)) say(`removed ${f.path}`);
    fs.rmSync(f.path, { force: true });
  }
  if (process.platform === 'linux') await capture('systemctl', ['--user', 'daemon-reload']);
}

/** Starts a service now: through the system's manager, else as a process of its own that outlives the caller. */
async function startService(name: ServiceName, url: string, say: Say): Promise<void> {
  const title = SERVICES.find((s) => s.name === name)!.title;
  const ours =
    process.platform === 'linux' ? (await capture('systemctl', ['--user', 'is-active', `nuclear-${name}`])).code === 0
    : process.platform === 'darwin' ? (await capture('launchctl', ['print', `gui/${process.getuid?.()}/${label(name)}`])).code === 0
    : true; // Windows keeps no state of a Startup script
  if (!ours && (await up(url))) {
    throw new Error(`a ${title} started by hand already answers at ${url}: stop it (${name === 'graph' ? "pkill -f 'nuclear-graph serve'" : "pkill -f 'uvicorn app.main:app'"}) and run the set-up again, so the service of this system takes its place`);
  }
  if (!(await restartService(name))) {
    const [cmd, ...args] = SERVICES.find((s) => s.name === name)!.args;
    spawn(path.join(binDir(), cmd), args, { env: { ...toolEnv(), ...readMachine() }, detached: true, stdio: 'ignore', shell: process.platform === 'win32' }).unref();
    say(`started ${cmd} (this system starts no services at login: start it again after a restart, here or in the editor's settings)`);
  }
  for (let i = 0; i < 120 && !(await up(url)); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await up(url))) throw new Error(`the ${title} does not answer at ${url}${process.platform === 'linux' ? ` (journalctl --user -u nuclear-${name} -n 30)` : ''}`);
  say(`${title}: ${url}`);
}

// ---------- the steps ----------

export type Say = (line: string) => void;

export interface Step {
  id: string;
  title: string;
  run: (say: Say) => Promise<void>;
}

function run(cmd: string, args: string[], say: Say, o: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: o.cwd, env: { ...toolEnv(), ...o.env }, shell: process.platform === 'win32' });
    let last = '';
    const lines = () => {
      let rest = '';
      return (d: Buffer | null) => {
        const parts = (rest + (d ?? '\n')).split(/[\r\n]+/);
        rest = parts.pop() ?? '';
        for (const line of parts.map((l) => l.trim()).filter((l) => l && !l.startsWith('[notice]'))) say((last = line));
      };
    };
    const [out, err] = [lines(), lines()];
    p.stdout.on('data', out);
    p.stderr.on('data', err);
    p.on('error', (e) => reject(new Error(`${cmd}: ${e.message}`)));
    p.on('close', (code) => {
      out(null);
      err(null);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} failed${last ? `: ${last}` : ` (${code})`}`));
    });
  });
}

/** A folder whose `python3` is a Python the services run on (3.12 or newer): the system's or one uv brings. */
async function pythonDir(build: string, say: Say): Promise<string> {
  let found = await capture('uv', ['python', 'find', '>=3.12']);
  if (found.code !== 0) {
    await run('uv', ['python', 'install', '3.12'], say);
    found = await capture('uv', ['python', 'find', '>=3.12']);
  }
  const python = found.out.trim().split('\n').pop() ?? '';
  if (found.code !== 0 || !fs.existsSync(python)) throw new Error(`no Python 3.12 or newer, and uv could not install one: ${found.out.trim()}`);
  if (process.platform === 'win32') return path.dirname(python);
  // the folder of a system Python may hold an older `python3`: a folder of our own with the one found
  const dir = path.join(build, '.python');
  fs.mkdirSync(dir, { recursive: true });
  for (const n of ['python3', 'python']) {
    fs.rmSync(path.join(dir, n), { force: true });
    fs.symlinkSync(python, path.join(dir, n));
  }
  return dir;
}

/** `nuclear-developer`: the built Developer with its environment, on the machine's models unless the caller gives
 * others (the editor does). */
export function launcher(root: string, machine = machineFile(), platform: NodeJS.Platform = process.platform): { name: string; text: string } {
  const build = path.join(root, 'nuclear-developer', 'build');
  if (platform === 'win32') {
    return { name: 'nuclear-developer.cmd', text: `@echo off\r\nrem The Nuclear Developer (ADR-0102), built in ${build} by the AI set-up.\r\nfor /f "usebackq eol=# tokens=1,* delims==" %%a in ("${machine}") do if not defined %%a set "%%a=%%b"\r\nif not defined NUCLEAR_DEVELOPER_PORT set NUCLEAR_DEVELOPER_PORT=7879\r\ncd /d "${build}" && .venv\\Scripts\\uvicorn app.main:app --host 127.0.0.1 --port %NUCLEAR_DEVELOPER_PORT% %*\r\n` };
  }
  return {
    name: 'nuclear-developer',
    text: `#!/bin/sh\n# The Nuclear Developer (ADR-0102), built in ${build} by the AI set-up.\n# The machine's models (${machine}), unless the caller already gave them.\nif [ -f "${machine}" ]; then\n  while IFS='=' read -r key value; do\n    case $key in [A-Z]*) eval "[ -n \\"\\\${$key+x}\\" ]" || export "$key=$value" ;; esac\n  done < "${machine}"\nfi\ncd "${build}" && exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port "\${NUCLEAR_DEVELOPER_PORT:-7879}" "$@"\n`,
  };
}

async function pull(ollamaUrl: string, model: string, say: Say): Promise<void> {
  const r = await fetch(ollamaUrl + '/api/pull', { method: 'POST', body: JSON.stringify({ model, stream: true }) });
  if (!r.ok || !r.body) throw new Error(`Ollama refused to pull ${model} (${r.status})`);
  let rest = '';
  let shown = '';
  for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) {
    const lines = (rest + Buffer.from(chunk).toString('utf8')).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const e = JSON.parse(line) as { status?: string; error?: string; completed?: number; total?: number };
      if (e.error) throw new Error(`${model}: ${e.error}`);
      const text = e.total ? `${model}: ${Math.floor((100 * (e.completed ?? 0)) / e.total)}% of ${(e.total / 1e9).toFixed(1)} GB` : `${model}: ${e.status ?? ''}`;
      if (text !== shown) say((shown = text));
    }
  }
}

/** The steps that leave a profile installed and running, in order. Each can be run again: what is there is kept. */
export function steps(p: Profile, root: string, u: Urls = urls()): Step[] {
  const editable = fs.existsSync(path.join(root, 'nuclear-graph', '.git'));
  const dev = path.join(root, 'nuclear-developer');
  const graph: Step = {
    id: 'graph',
    title: p.coder ? 'Install the Smart Graph and the MCP server' : 'Install the MCP server',
    run: async (say) => {
      // the graph is written in Nuclear: its Python package is what `nuclear build` writes, so it is built first
      await run('nuclear', ['build', path.join(root, 'nuclear-graph')], say, { env: toolEnv() });
      await run('uv', ['tool', 'install', '--force', '--no-progress', ...(editable ? ['--editable'] : []), `${path.join(root, 'nuclear-graph')}[${p.coder ? 'server' : 'mcp'}]`], (line) => /^[+~-] /.test(line) || say(line), { env: { UV_TOOL_BIN_DIR: binDir() } });
    },
  };
  if (!p.coder) {
    return [graph, {
      id: 'machine',
      title: 'Keep the choice',
      run: async (say) => {
        await removeServices(say);
        writeMachine(machineOf(p));
        say(`wrote ${machineFile()}`);
      },
    }];
  }
  const models = [...new Set([EMBEDDINGS, p.coder, p.assistant ?? p.coder])];
  return [
    graph,
    {
      id: 'developer',
      title: 'Build and install the Nuclear Developer',
      run: async (say) => {
        const env = toolEnv();
        const python = await pythonDir(path.join(dev, 'build'), say);
        await run('dragonfly', ['install'], say, { cwd: dev, env: { PATH: `${python}${path.delimiter}${env.PATH ?? ''}` } });
        const l = launcher(root);
        fs.mkdirSync(binDir(), { recursive: true });
        fs.writeFileSync(path.join(binDir(), l.name), l.text, { mode: 0o755 });
        say(`wrote ${path.join(binDir(), l.name)}`);
      },
    },
    {
      id: 'models',
      title: `Download the models (${models.join(', ')})`,
      run: async (say) => {
        const have = await installedModels(u.ollama);
        for (const m of models) {
          if (hasModel(have, m)) say(`${m}: already here`);
          else await pull(u.ollama, m, say);
        }
      },
    },
    {
      id: 'graph-service',
      title: 'Start the Smart Graph, now and at every login',
      run: async (say) => {
        writeMachine(machineOf(p));
        say(`wrote ${machineFile()}`);
        await enableServices(say);
        await startService('graph', u.graph + '/v1/health', say);
      },
    },
    {
      id: 'knowledge',
      title: 'Load the knowledge base into the graph',
      run: async (say) => {
        const tool = path.join(binDir(), 'nuclear-graph');
        for (const client of ['nuclear-developer', 'mcp']) await run(tool, ['connect', client, '--scopes', 'read,write'], say);
        await run(tool, ['ingest', path.join(dev, 'data')], (line) => /^[{}"\]]/.test(line) || say(line));
        say('the graph holds the knowledge base');
      },
    },
    {
      id: 'developer-service',
      title: 'Start the Nuclear Developer, now and at every login',
      run: (say) => startService('developer', u.developer + '/docs', say),
    },
  ];
}

/** Takes the services away: what starts them, the graph's tool, the Developer's launcher and the machine's file. The
 * models and Ollama stay (they are the user's), and so does the graph's data. */
export async function remove(say: Say = () => undefined): Promise<void> {
  await removeServices(say);
  if (which('uv')) await capture('uv', ['tool', 'uninstall', 'nuclear-graph']);
  for (const f of [path.join(binDir(), launcher('').name), machineFile()]) {
    if (fs.existsSync(f)) say(`removed ${f}`);
    fs.rmSync(f, { force: true });
  }
}
