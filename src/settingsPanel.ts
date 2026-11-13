// The Settings and integrations tool (Ctrl+Alt+S): every setting of the AI loop in one page. The services (the Smart
// Graph, the Nuclear Developer, Ollama) with their state and Start / Restart with the chosen models; the local models
// (installed, their size against the 3B rule, pull); the MCP server in Claude Code, Codex and Cursor; the connections
// (the graph's clients and pending access requests, Jira, GitHub); the pipeline (Claude's model, retries). Values are
// the editor's `nuclear.ai.*` settings (aiSettings.ts). Plain HTML and script, no framework.
import { ChildProcess, execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { aiSettings, JIRA_SECRET, jiraAuth, serviceEnv } from './aiSettings';
import { readMachine, restartService, serviceFiles, writeMachine } from './aiSetup';
import { billionsOf, MAX_BILLIONS } from './localModels';
import { checkAll } from './connections';
import { notices } from './notifications';

type Message =
  | { type: 'ready' }
  | { type: 'set'; key: string; value: unknown }
  | { type: 'start'; service: 'graph' | 'developer' }
  | { type: 'pull'; model: string }
  | { type: 'mcp'; client: 'claude' | 'codex' | 'cursor' | 'opencode' }
  | { type: 'allow' | 'deny'; id: string }
  | { type: 'revoke'; client: string }
  | { type: 'connectMcp' }
  | { type: 'jira' | 'jiraOff' | 'openSettings' | 'setup' };

export interface LocalModel {
  name: string;
  size: number;
  parameters: string;
  /** Billions of parameters that count for the rule: the effective size of an `eNb` model, else its parameters. */
  billions: number;
}

const own = new Map<string, ChildProcess>(); // services started from the editor

function run(cmd: string, args: string[], cwd?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 20000, env: serviceEnv() }, (e, stdout, stderr) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, out: `${stdout}${stderr}` }));
  });
}

async function up(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
    return r.status < 500;
  } catch {
    return false;
  }
}

export class SettingsPanel {
  private static current: SettingsPanel | undefined;
  private readonly panel: vscode.WebviewPanel;

  private constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = vscode.window.createWebviewPanel('nuclear.settings', 'Settings and integrations', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icons', 'nuc-file.svg');
    this.panel.webview.html = html(this.panel.webview);
    this.panel.onDidDispose(() => {
      SettingsPanel.current = undefined;
      notices.watch('settings', false);
    });
    this.panel.onDidChangeViewState((e) => notices.watch('settings', e.webviewPanel.visible && e.webviewPanel.active));
    this.panel.webview.onDidReceiveMessage((m: Message) => void this.receive(m).catch((e) => void vscode.window.showErrorMessage(`Nuclear settings: ${e instanceof Error ? e.message : e}`)));
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('nuclear.ai') && void this.state()));
  }

  static show(context: vscode.ExtensionContext): void {
    const p = SettingsPanel.current ?? (SettingsPanel.current = new SettingsPanel(context));
    p.panel.reveal(vscode.ViewColumn.Active);
    notices.watch('settings', true);
    void p.state();
  }

  static close(): void {
    SettingsPanel.current?.panel.dispose();
  }

  /** Stops the services the editor started (on deactivation). */
  static stopServices(): void {
    for (const p of own.values()) p.kill();
    own.clear();
  }

  private post(m: unknown): void {
    void this.panel.webview.postMessage(m);
  }

  private async models(): Promise<LocalModel[] | string> {
    try {
      const r = await fetch(aiSettings().ollamaUrl + '/api/tags', { signal: AbortSignal.timeout(3000) });
      const data = (await r.json()) as { models: { name: string; size: number; details?: { parameter_size?: string } }[] };
      return data.models.map((m) => ({ name: m.name, size: m.size, parameters: m.details?.parameter_size ?? '', billions: billionsOf(m.name, m.details?.parameter_size ?? '') })).sort((a, b) => a.billions - b.billions);
    } catch (e) {
      return `Ollama does not answer at ${aiSettings().ollamaUrl} (${e instanceof Error ? e.message : e})`;
    }
  }

  private async mcpState(): Promise<Record<string, string>> {
    const has = async (cmd: string) => (await run('sh', ['-c', 'command -v "$1"', 'sh', cmd])).code === 0;
    const out: Record<string, string> = {};
    out.claude = !(await has('claude')) ? 'not installed' : (await run('claude', ['mcp', 'get', 'nuclear'])).code === 0 ? 'added' : 'not added';
    out.codex = !(await has('codex')) ? 'not installed' : /\bnuclear\b/.test((await run('codex', ['mcp', 'list'])).out) ? 'added' : 'not added';
    const c = vscode.workspace.getConfiguration('nuclear.ai');
    const home = (f: string) => f.replace(/^~(?=\/|$)/, os.homedir());
    const cursor = home(c.get('cursor.mcpFile', '~/.cursor/mcp.json'));
    try {
      out.cursor = (JSON.parse(fs.readFileSync(cursor, 'utf8')) as { mcpServers?: Record<string, unknown> }).mcpServers?.nuclear ? 'added' : 'not added';
    } catch {
      out.cursor = fs.existsSync(path.join(os.homedir(), '.cursor')) ? 'not added' : 'not installed';
    }
    const oc = home(c.get('opencode.configFile', '~/.config/opencode/opencode.json'));
    try {
      out.opencode = (JSON.parse(fs.readFileSync(oc, 'utf8')) as { mcp?: Record<string, unknown> }).mcp?.nuclear ? 'added' : 'not added';
    } catch {
      out.opencode = (await has(c.get('opencode.command', 'opencode'))) ? 'not added' : 'not installed';
    }
    return out;
  }

  private async state(): Promise<void> {
    const s = aiSettings();
    const access = await run(s.mcpCommand, ['requests']);
    let graphAccess: { requests: Record<string, { client: string; scopes: string[]; reason: string; status: string }>; clients: Record<string, { scopes: string[] }> } | null = null;
    try {
      graphAccess = JSON.parse(access.out.slice(access.out.indexOf('{')));
    } catch {
      graphAccess = null;
    }
    const c = vscode.workspace.getConfiguration('nuclear.ai');
    const integrations = {
      claude: { command: c.get('claude.command', 'claude'), maxBudgetUsd: c.get('claude.maxBudgetUsd', 2) },
      codex: { enabled: c.get('codex.enabled', false), command: c.get('codex.command', 'codex') },
      opencode: { enabled: c.get('opencode.enabled', false), command: c.get('opencode.command', 'opencode'), configFile: c.get('opencode.configFile', '~/.config/opencode/opencode.json') },
      cursor: { mcpFile: c.get('cursor.mcpFile', '~/.cursor/mcp.json') },
      github: { command: c.get('github.command', 'gh') },
      jira: { site: c.get('jira.site', ''), email: c.get('jira.email', ''), criteriaField: c.get('jira.criteriaField', '') },
      watch: { callTimeoutMinutes: c.get('watch.callTimeoutMinutes', 15), stallSeconds: c.get('watch.stallSeconds', 90), minFreeMb: c.get('watch.minFreeMb', 500) },
      resumeInterrupted: c.get('resumeInterrupted', true),
      checkEveryMinutes: c.get('checkEveryMinutes', 5),
    };
    const [checks, graph, developer, ollama, models, mcp, gh] = await Promise.all([
      checkAll(this.context),
      up(s.graphUrl + '/v1/health'),
      up(s.developerUrl + '/docs'),
      up(s.ollamaUrl + '/api/tags'),
      this.models(),
      this.mcpState(),
      run('gh', ['auth', 'status']),
    ]);
    this.post({
      type: 'state',
      settings: s,
      services: { graph, developer, ollama, own: [...own.keys()], atLogin: serviceFiles().length > 0 && serviceFiles().every((f) => fs.existsSync(f.path)) },
      profile: readMachine().NUCLEAR_AI_PROFILE ?? '',
      models,
      max: MAX_BILLIONS,
      mcp,
      graphAccess,
      jira: !!(await this.context.secrets.get(JIRA_SECRET)),
      github: gh.code === 0,
      checks,
      integrations,
    });
  }

  private async receive(m: Message): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.state();
      case 'set':
        await vscode.workspace.getConfiguration('nuclear.ai').update(m.key, m.value, vscode.ConfigurationTarget.Global);
        return; // onDidChangeConfiguration redraws
      case 'start':
        return this.start(m.service);
      case 'pull':
        return this.pull(m.model);
      case 'mcp':
        return this.addMcp(m.client);
      case 'connectMcp': {
        const r = await run(aiSettings().mcpCommand, ['connect', 'mcp', '--scopes', 'read,write']);
        void vscode.window.showInformationMessage(r.out.trim() || 'done');
        return this.state();
      }
      case 'allow':
      case 'deny': {
        const r = await run(aiSettings().mcpCommand, [m.type, m.id]);
        void vscode.window.showInformationMessage(r.out.trim());
        return this.state();
      }
      case 'revoke': {
        const ok = await vscode.window.showWarningMessage(`Take the graph's access away from '${m.client}'?`, { modal: true }, 'Revoke');
        if (ok !== 'Revoke') return;
        await run(aiSettings().mcpCommand, ['revoke', m.client]);
        return this.state();
      }
      case 'jira':
        await jiraAuth(this.context, true);
        return this.state();
      case 'jiraOff':
        await this.context.secrets.delete(JIRA_SECRET);
        return this.state();
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'nuclear.ai');
        return;
      case 'setup':
        await vscode.commands.executeCommand('nuclear.ai.setup');
        return;
    }
  }

  /** Starts (or restarts, when the editor started it) the graph or the Developer with the settings' models. */
  private async start(service: 'graph' | 'developer'): Promise<void> {
    const s = aiSettings();
    const [cmd, args, url] = service === 'graph' ? [s.mcpCommand, ['serve'], s.graphUrl + '/v1/health'] : ['nuclear-developer', [], s.developerUrl + '/docs'];
    // the services the set-up left in this system (ADR-0106) start with the machine's file: the models chosen here go
    // there, and the system's manager starts the service again
    if (readMachine().NUCLEAR_AI_MODE === 'local') writeMachine({ CODER_MODEL: s.coderModel, ASSISTANT_MODEL: s.assistantModel, NUCLEAR_GRAPH_EMBED: s.embeddingsModel });
    if (!own.has(service) && (await restartService(service))) {
      for (let i = 0; i < 40 && !(await up(url)); i++) await new Promise((r) => setTimeout(r, 500));
      return this.state();
    }
    const mine = own.get(service);
    if (mine) {
      mine.kill();
      own.delete(service);
      await new Promise((r) => setTimeout(r, 800));
    } else if (await up(url)) {
      void vscode.window.showWarningMessage(`The ${service === 'graph' ? 'Smart Graph' : 'Nuclear Developer'} is already running, started outside the editor: stop it there to restart it with these settings.`);
      return;
    }
    if ((await run('sh', ['-c', 'command -v "$1"', 'sh', cmd])).code !== 0) {
      const go = await vscode.window.showErrorMessage(`${cmd} is not installed.`, 'Set up the AI services');
      if (go) await vscode.commands.executeCommand('nuclear.ai.setup');
      return;
    }
    const p = spawn(cmd, args, { env: serviceEnv(), stdio: 'ignore' });
    own.set(service, p);
    p.on('exit', () => {
      if (own.get(service) === p) own.delete(service);
      void this.state();
    });
    for (let i = 0; i < 20 && !(await up(url)); i++) await new Promise((r) => setTimeout(r, 500));
    return this.state();
  }

  private async pull(model: string): Promise<void> {
    if (!/^[\w.:/-]+$/.test(model)) return;
    const task = new vscode.Task({ type: 'nuclear', task: 'pull' }, vscode.TaskScope.Global, `ollama pull ${model}`, 'nuclear', new vscode.ProcessExecution('ollama', ['pull', model], { env: serviceEnv() as Record<string, string> }));
    const done = new Promise<void>((resolve) => {
      const sub = vscode.tasks.onDidEndTaskProcess((e) => {
        if (e.execution.task === task) {
          sub.dispose();
          resolve();
        }
      });
    });
    await vscode.tasks.executeTask(task);
    await done;
    return this.state();
  }

  private async addMcp(client: 'claude' | 'codex' | 'cursor' | 'opencode'): Promise<void> {
    const cmd = aiSettings().mcpCommand;
    const c = vscode.workspace.getConfiguration('nuclear.ai');
    const home = (f: string) => f.replace(/^~(?=\/|$)/, os.homedir());
    if (client === 'opencode') {
      // OpenCode reads its MCP servers from the `mcp` table of its config: a local command
      const file = home(c.get('opencode.configFile', '~/.config/opencode/opencode.json'));
      let json: { mcp?: Record<string, unknown> } = {};
      try {
        json = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        if (fs.existsSync(file)) throw new Error(`${file} is not valid JSON: fix it first`);
      }
      json.mcp = { ...(json.mcp ?? {}), nuclear: { type: 'local', command: [cmd, 'mcp'], enabled: true } };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    } else if (client === 'cursor') {
      const file = home(c.get('cursor.mcpFile', '~/.cursor/mcp.json'));
      let json: { mcpServers?: Record<string, unknown> } = {};
      try {
        json = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        if (fs.existsSync(file)) throw new Error(`${file} is not valid JSON: fix it first`);
      }
      json.mcpServers = { ...(json.mcpServers ?? {}), nuclear: { command: cmd, args: ['mcp'] } };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
    } else {
      const args = client === 'claude' ? ['mcp', 'add', '--scope', 'user', 'nuclear', '--', cmd, 'mcp'] : ['mcp', 'add', 'nuclear', '--', cmd, 'mcp'];
      const r = await run(client === 'claude' ? c.get('claude.command', 'claude') : c.get('codex.command', 'codex'), args);
      if (r.code !== 0) throw new Error(`${client} ${args.join(' ')}: ${r.out.trim()}`);
    }
    void vscode.window.showInformationMessage(`The Nuclear MCP server is in ${{ claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode' }[client]}.`);
    return this.state();
  }
}

export function html(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; padding: 16px 28px 40px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 980px; }
  h1 { font-size: 20px; margin: 4px 0 2px; } h2 { font-size: 14px; margin: 26px 0 8px; text-transform: uppercase; letter-spacing: .05em; opacity: .8; }
  .muted { opacity: .65; } .grid { display: grid; grid-template-columns: 220px 1fr; gap: 8px 16px; align-items: center; }
  input, select, button { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; padding: 3px 8px; }
  button { cursor: pointer; } button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
  input { width: 100%; box-sizing: border-box; } input[type=number] { width: 120px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 10px 14px; margin-bottom: 8px; display: flex; gap: 12px; align-items: center; }
  .card .grow { flex: 1; } .dot { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
  .on { background: #16a34a; } .off { background: #b91c1c; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .over { color: var(--vscode-errorForeground); } .badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; border: 1px solid var(--vscode-panel-border); }
</style></head><body>
<h1>Settings and integrations</h1>
<div class="muted">The AI loop of NuclearLang: everything here is a setting of the editor (<a href="#" id="openSettings">nuclear.ai</a>); a project's <code>.nuclear/loop.json</code> still wins for its own pipeline.</div>
<div id="root">Loading…</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const gb = (n) => (n / 1e9).toFixed(1) + ' GB';
let S = null;
function field(key, label, value, help, type) {
  return '<label>' + esc(label) + '<div class="muted">' + esc(help) + '</div></label><input data-key="' + key + '" type="' + (type || 'text') + '" value="' + esc(value) + '">';
}
function modelSelect(key, label, value, help) {
  const list = Array.isArray(S.models) ? S.models : [];
  const names = list.map((m) => m.name);
  const opts = (names.includes(value) ? names : [value, ...names]).map((n) => { const m = list.find((x) => x.name === n); return '<option value="' + esc(n) + '"' + (n === value ? ' selected' : '') + '>' + esc(n) + (m ? ' · ' + esc(m.parameters) + (m.billions > S.max ? ' · over 3B' : '') : ' · not installed') + '</option>'; }).join('');
  const m = list.find((x) => x.name === value);
  const warn = !m ? ' <button data-pull="' + esc(value) + '">Pull</button>' : m.billions > S.max ? ' <span class="over">over the 3B rule</span>' : '';
  return '<label>' + esc(label) + '<div class="muted">' + esc(help) + '</div></label><div><select data-key="' + key + '">' + opts + '</select>' + warn + '</div>';
}
function service(id, name, on, what, startable) {
  return '<div class="card"><span class="dot ' + (on ? 'on' : 'off') + '"></span><div class="grow"><b>' + esc(name) + '</b> <span class="muted">' + esc(what) + '</span></div>' + (startable ? '<button data-start="' + id + '">' + (S.services.own.includes(id) || (S.services.atLogin && on) ? 'Restart' : on ? 'Running' : 'Start') + '</button>' : '') + '</div>';
}
function draw() {
  const s = S.settings;
  const models = Array.isArray(S.models) ? S.models : [];
  const access = S.graphAccess;
  const mcpName = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode' };
  const I = S.integrations;
  const check = (c) => '<div class="card"><span class="dot ' + (c.ok ? 'on' : 'off') + '"></span><div class="grow"><b>' + esc(c.name) + '</b> <span class="muted">' + esc(c.detail) + '</span></div></div>';
  const toggle = (key, label, value, help) => '<label>' + esc(label) + '<div class="muted">' + esc(help) + '</div></label><div><input type="checkbox" data-key="' + key + '"' + (value ? ' checked' : '') + ' style="width:auto"></div>';
  document.getElementById('root').innerHTML =
    '<h2>Connections, checked now</h2><div class="muted">Every external connection, checked before each task and every ' + I.checkEveryMinutes + ' min; a notification says when one stops answering.</div>'
    + S.checks.map(check).join('')
    + '<h2>Services</h2><div class="muted" style="margin-bottom:8px">' + (S.profile ? 'Profile <b>' + esc(S.profile) + '</b>' + (S.services.atLogin ? ', started at every login' : '') + '. ' : 'Not set up yet. ') + '<button data-act="setup">Set-up…</button></div>'
    + service('graph', 'Nuclear Smart Graph', S.services.graph, s.graphUrl + ' · the private knowledge base and the MCP server', true)
    + service('developer', 'Nuclear Developer', S.services.developer, s.developerUrl + ' · the local agents (started with the models below)', true)
    + service('ollama', 'Ollama', S.services.ollama, s.ollamaUrl + ' · runs the local models', false)
    + '<div class="grid">' + field('graphUrl', 'Smart Graph url', s.graphUrl, 'nuclear-graph serve') + field('developerUrl', 'Developer url', s.developerUrl, 'nuclear-developer') + field('ollamaUrl', 'Ollama url', s.ollamaUrl, 'where the models run') + '</div>'
    + '<h2>Local models</h2><div class="muted">At most 3B parameters (effective size for e2b/e4b models). A change applies when the service restarts.</div><div class="grid" style="margin-top:8px">'
    + modelSelect('models.coder', 'Coder', s.coderModel, 'writes and repairs the code, the tests')
    + modelSelect('models.assistant', 'Assistant', s.assistantModel, 'plans, reviews, documents, diagnoses, chats')
    + modelSelect('models.embeddings', 'Embeddings', s.embeddingsModel, 'the graph\\'s search (re-ingest after a change)')
    + '</div>' + (typeof S.models === 'string' ? '<p class="over">' + esc(S.models) + '</p>' : '<details style="margin-top:8px"><summary>Installed models (' + models.length + ')</summary><table><tr><th>Model</th><th>Parameters</th><th>Size</th><th></th></tr>' + models.map((m) => '<tr><td>' + esc(m.name) + '</td><td>' + esc(m.parameters) + '</td><td>' + gb(m.size) + '</td><td>' + (m.billions > S.max ? '<span class="over">over 3B</span>' : '<span class="badge">allowed</span>') + '</td></tr>').join('') + '</table></details>')
    + '<h2>MCP server</h2><div class="muted">The Nuclear MCP server (<code>' + esc(s.mcpCommand) + ' mcp</code>) lets Claude, Codex or Cursor give each task to the local developer first, then validate and correct.</div>'
    + Object.keys(mcpName).map((c) => '<div class="card"><span class="dot ' + (S.mcp[c] === 'added' ? 'on' : 'off') + '"></span><div class="grow"><b>' + mcpName[c] + '</b> <span class="muted">' + esc(S.mcp[c]) + '</span></div>' + (S.mcp[c] === 'not added' ? '<button class="primary" data-mcp="' + c + '">Add</button>' : '') + '</div>').join('')
    + '<div class="grid">' + field('mcpCommand', 'MCP command', s.mcpCommand, 'the program that serves it') + '</div>'
    + '<h2>Connections</h2>'
    + '<div class="card"><div class="grow"><b>Smart Graph clients</b> <span class="muted">programs that may read the graph</span></div>' + (access && !access.clients.mcp ? '<button data-act="connectMcp">Allow MCP clients</button>' : '') + '</div>'
    + (access ? '<table>' + Object.entries(access.clients).map(([name, c]) => '<tr><td>' + esc(name) + '</td><td>' + esc(c.scopes.join(', ')) + '</td><td><button data-revoke="' + esc(name) + '">Revoke</button></td></tr>').join('')
      + Object.entries(access.requests).filter(([, r]) => r.status === 'pending').map(([id, r]) => '<tr><td><b>' + esc(r.client) + '</b> asks</td><td>' + esc(r.scopes.join(', ')) + ' · ' + esc(r.reason) + '</td><td><button class="primary" data-allow="' + esc(id) + '">Allow</button> <button data-deny="' + esc(id) + '">Deny</button></td></tr>').join('') + '</table>' : '<p class="muted">The graph\\'s access list is not readable (is nuclear-graph installed?).</p>')
    + '<div class="card"><span class="dot ' + (S.jira ? 'on' : 'off') + '"></span><div class="grow"><b>Jira</b> <span class="muted">import issues as specs in the Loop · secret storage</span></div><button data-act="jira">' + (S.jira ? 'Change' : 'Connect') + '</button>' + (S.jira ? '<button data-act="jiraOff">Disconnect</button>' : '') + '</div>'
    + '<div class="card"><span class="dot ' + (S.github ? 'on' : 'off') + '"></span><div class="grow"><b>GitHub</b> <span class="muted">' + (S.github ? 'gh is signed in' : 'run gh auth login in a terminal') + '</span></div></div>'
    + '<h2>Integrations</h2><div class="grid">'
    + field('claude.command', 'Claude Code: command', I.claude.command, 'the lead of a Loop run when Claude leads')
    + field('claude.maxBudgetUsd', 'Claude: budget per run (USD)', I.claude.maxBudgetUsd, 'the most a Loop run led by Claude may spend; 0: no limit', 'number')
    + toggle('codex.enabled', 'Codex', I.codex.enabled, 'its MCP entry and its regular check') + field('codex.command', 'Codex: command', I.codex.command, '')
    + toggle('opencode.enabled', 'OpenCode', I.opencode.enabled, 'its MCP entry and its regular check') + field('opencode.command', 'OpenCode: command', I.opencode.command, '') + field('opencode.configFile', 'OpenCode: config file', I.opencode.configFile, 'where the MCP server is added')
    + field('cursor.mcpFile', 'Cursor: MCP file', I.cursor.mcpFile, 'where the MCP server is added')
    + field('github.command', 'GitHub: command', I.github.command, 'issues imported as specs (gh auth login once)')
    + field('jira.site', 'Jira: site', I.jira.site, 'https://your-team.atlassian.net; the API token is a secret (Connect)') + field('jira.email', 'Jira: email', I.jira.email, 'of your Atlassian account') + field('jira.criteriaField', 'Jira: criteria field', I.jira.criteriaField, 'optional: customfield_10050')
    + '</div>'
    + '<h2>When something fails</h2><div class="grid">'
    + toggle('resumeInterrupted', 'Resume interrupted runs', I.resumeInterrupted, 'a run the editor left half done goes on from the step where it stopped')
    + field('watch.callTimeoutMinutes', 'Longest call (min)', I.watch.callTimeoutMinutes, 'a call to the local agents that takes longer is cut and retried', 'number')
    + field('watch.stallSeconds', 'Stalled after (s)', I.watch.stallSeconds, 'the Developer silent or Ollama holding no model this long: cut and retried', 'number')
    + field('watch.minFreeMb', 'Free disk needed (MB)', I.watch.minFreeMb, 'checked before every run', 'number')
    + field('checkEveryMinutes', 'Check connections every (min)', I.checkEveryMinutes, '0: only before each task', 'number')
    + '</div>'
    + '<h2>Pipeline</h2><div class="grid">'
    + '<label>Claude\\'s model<div class="muted">when Claude leads a Loop run</div></label><select data-key="claudeModel">' + ['sonnet', 'opus', 'haiku'].map((m) => '<option' + (m === s.claudeModel ? ' selected' : '') + '>' + m + '</option>').join('') + '</select>'
    + field('retry.attempts', 'Tries of a call', s.retry.attempts, 'a call to the local agents that fails for a passing reason (down, busy, 5xx) is retried', 'number')
    + field('retry.baseMs', 'First wait (ms)', s.retry.baseMs, 'doubles at each retry, with random jitter', 'number')
    + field('retry.maxMs', 'Longest wait (ms)', s.retry.maxMs, 'the cap of a wait', 'number')
    + '</div>';
}
document.addEventListener('change', (e) => {
  const k = e.target.dataset.key; if (!k) return;
  const v = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'number' ? Number(e.target.value) : e.target.value;
  vscode.postMessage({ type: 'set', key: k, value: v });
});
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-start],[data-pull],[data-mcp],[data-allow],[data-deny],[data-revoke],[data-act],#openSettings'); if (!d) return;
  e.preventDefault();
  if (d.id === 'openSettings') return vscode.postMessage({ type: 'openSettings' });
  if (d.dataset.start) { d.disabled = true; d.textContent = 'Starting…'; return vscode.postMessage({ type: 'start', service: d.dataset.start }); }
  if (d.dataset.pull) { d.disabled = true; d.textContent = 'Pulling…'; return vscode.postMessage({ type: 'pull', model: d.dataset.pull }); }
  if (d.dataset.mcp) return vscode.postMessage({ type: 'mcp', client: d.dataset.mcp });
  if (d.dataset.allow) return vscode.postMessage({ type: 'allow', id: d.dataset.allow });
  if (d.dataset.deny) return vscode.postMessage({ type: 'deny', id: d.dataset.deny });
  if (d.dataset.revoke) return vscode.postMessage({ type: 'revoke', client: d.dataset.revoke });
  if (d.dataset.act) return vscode.postMessage({ type: d.dataset.act });
});
window.addEventListener('message', (e) => { if (e.data.type === 'state') { S = e.data; draw(); } });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
