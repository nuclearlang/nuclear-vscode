// The set-up of the AI services, in steps (ADR-0106): this machine and where the agents run (here, or only remote
// agents), the profile (which models are downloaded and how far each works, one suggested for the hardware), what is
// needed (found by itself once installed, or installed in a terminal), and the installation with its progress.
// The page asks and shows; everything it does is aiSetup.ts. Plain HTML and script, no framework.
import * as vscode from 'vscode';
import { PROFILES, Step, aiRoot, fit, hardware, Hardware, profileOf, readMachine, recommend, requirements, steps } from './aiSetup';
import { toolEnv } from './loopEngine';

type Message =
  | { type: 'ready' | 'check' | 'settings' }
  | { type: 'install'; id: string }
  | { type: 'open'; url: string }
  | { type: 'go'; profile: string; from: number };

export class SetupPanel {
  private static current: SetupPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private hw: Hardware | undefined;
  private running = false;

  private constructor() {
    this.panel = vscode.window.createWebviewPanel('nuclear.setup', 'Set up the AI services', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.webview.html = html(this.panel.webview);
    this.panel.onDidDispose(() => (SetupPanel.current = undefined));
    this.panel.webview.onDidReceiveMessage((m: Message) => void this.receive(m).catch((e) => void vscode.window.showErrorMessage(`Nuclear set-up: ${e instanceof Error ? e.message : e}`)));
  }

  static show(): void {
    (SetupPanel.current ?? (SetupPanel.current = new SetupPanel())).panel.reveal(vscode.ViewColumn.Active);
  }

  /** Once, when the extension starts on a machine that was never set up: the offer, never the page by itself. */
  static async offer(context: vscode.ExtensionContext): Promise<void> {
    const KEY = 'nuclear.ai.setup.declined';
    if (readMachine().NUCLEAR_AI_MODE || context.globalState.get(KEY)) return;
    const pick = await vscode.window.showInformationMessage(
      'NuclearLang: set up the AI services? Local agents write the code and save the tokens of your remote agent. The set-up reads this machine and suggests what to install; you choose.',
      'Set up', 'Later', "Don't ask again",
    );
    if (pick === 'Set up') SetupPanel.show();
    if (pick === "Don't ask again") await context.globalState.update(KEY, true);
  }

  private post(m: unknown): void {
    void this.panel.webview.postMessage(m);
  }

  private async state(): Promise<void> {
    const hw = this.hw ?? (this.hw = await hardware());
    const [local, remote] = await Promise.all([requirements(true), requirements(false)]);
    this.post({
      type: 'state',
      hw,
      platform: process.platform,
      suggested: recommend(hw),
      profiles: PROFILES.map((p) => ({ ...p, ...fit(p, hw) })),
      machine: readMachine(),
      requirements: { local, remote },
    });
  }

  private async receive(m: Message): Promise<void> {
    switch (m.type) {
      case 'ready':
      case 'check':
        return this.state();
      case 'settings':
        await vscode.commands.executeCommand('nuclear.workspace.tool', 'settings');
        return;
      case 'open':
        await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
      case 'install': {
        // in a terminal the user sees: an installer may ask for a password, and its output is theirs to read
        const r = (await requirements(true)).find((x) => x.id === m.id);
        const command = r?.install[process.platform];
        if (!r || !command) return;
        const t = vscode.window.createTerminal({ name: `Install ${r.title}`, env: toolEnv() as Record<string, string> });
        t.show();
        t.sendText(command);
        return;
      }
      case 'go':
        return this.install(m.profile, m.from);
    }
  }

  private async install(id: string, from: number): Promise<void> {
    const p = profileOf(id);
    const root = aiRoot();
    if (!p || !root || this.running) return;
    this.running = true;
    const all: Step[] = steps(p, root);
    this.post({ type: 'steps', titles: all.map((s) => s.title), from });
    try {
      for (const [i, step] of all.entries()) {
        if (i < from) continue;
        this.post({ type: 'step', index: i, status: 'running', line: '' });
        try {
          await step.run((line) => this.post({ type: 'step', index: i, status: 'running', line }));
          this.post({ type: 'step', index: i, status: 'done', line: '' });
        } catch (e) {
          this.post({ type: 'step', index: i, status: 'failed', line: e instanceof Error ? e.message : String(e) });
          return;
        }
      }
      this.post({ type: 'done', profile: p.id, local: !!p.coder });
    } finally {
      this.running = false;
    }
  }
}

export function html(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; padding: 16px 28px 40px; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); max-width: 860px; }
  h1 { font-size: 20px; margin: 4px 0 2px; } h2 { font-size: 15px; margin: 22px 0 6px; }
  .muted { opacity: .7; } .steps { display: flex; gap: 14px; margin: 10px 0 4px; font-size: 12px; } .steps span { opacity: .5; } .steps .now { opacity: 1; font-weight: 600; border-bottom: 2px solid var(--vscode-focusBorder); }
  button { font: inherit; cursor: pointer; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: none; border-radius: 4px; padding: 5px 14px; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); } button:disabled { opacity: .5; cursor: default; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 16px; margin: 8px 0; cursor: pointer; }
  .card.on { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); } .card.plain { cursor: default; }
  .card h3 { margin: 0 0 4px; font-size: 14px; } .card ul { margin: 6px 0 0; padding-left: 0; list-style: none; } .card li { margin: 2px 0; }
  .badge { font-size: 11px; padding: 1px 7px; border-radius: 8px; border: 1px solid var(--vscode-panel-border); margin-left: 6px; font-weight: normal; }
  .badge.best { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
  .warn { color: var(--vscode-editorWarning-foreground); } .bad { color: var(--vscode-errorForeground); } .ok { color: var(--vscode-testing-iconPassed, #3fb950); }
  .row { display: flex; gap: 12px; align-items: center; } .grow { flex: 1; } .nav { display: flex; gap: 8px; margin-top: 18px; }
  code { font-family: var(--vscode-editor-font-family); font-size: 12px; } a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .line { font-family: var(--vscode-editor-font-family); font-size: 12px; opacity: .75; word-break: break-all; }
</style></head><body>
<h1>Set up the AI services</h1>
<div class="muted">Nothing is downloaded until you press Install. You can run this again at any time to change your choice.</div>
<div class="steps" id="steps"></div>
<div id="root">Reading this machine…</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const PAGES = ['This machine', 'Profile', 'Requirements', 'Install'];
let S = null, page = 0, local = true, profile = '', run = null, timer = null;
const chosen = () => S.profiles.find((p) => p.id === (local ? profile : 'remote'));
const needs = () => S.requirements[local ? 'local' : 'remote'];

function profileCard(p, pick) {
  const badge = p.id === S.suggested ? '<span class="badge best">Suggested for this machine</span>' : p.fit === 'no' ? '<span class="badge bad">Not for this machine</span>' : p.fit === 'tight' ? '<span class="badge warn">Tight on this machine</span>' : '';
  return '<div class="card ' + (pick ? (p.id === profile ? 'on' : '') : 'plain') + '"' + (pick ? ' data-profile="' + p.id + '"' : '') + '><h3>' + esc(p.title) + badge + '</h3>'
    + '<div>' + esc(p.summary) + '</div>'
    + (p.coder ? '<div class="muted" style="margin-top:4px">Downloads ' + p.gb + ' GB · ' + p.ram + ' GB of memory recommended (' + p.minRam + ' GB at least) · <code>' + [...new Set([p.coder, p.assistant])].map(esc).join('</code> + <code>') + '</code></div>'
      + '<div class="' + (p.fit === 'no' ? 'bad' : p.fit === 'tight' ? 'warn' : 'muted') + '">On this machine: ' + esc(p.note) + '.</div>' : '')
    + (p.coder ? '<div class="muted">Measured: ' + esc(p.measured) + '.</div>' : '')
    + '<ul>' + p.works.map((w) => '<li><span class="ok">✓</span> ' + esc(w) + '</li>').join('') + p.limits.map((l) => '<li><span class="warn">✗</span> ' + esc(l) + '</li>').join('') + '</ul></div>';
}

function draw() {
  document.getElementById('steps').innerHTML = PAGES.map((t, i) => '<span class="' + (i === page ? 'now' : '') + '">' + (i + 1) + '. ' + t + '</span>').join('');
  const h = S.hw;
  let out = '';
  if (page === 0) {
    const was = S.machine.NUCLEAR_AI_PROFILE ? '<div class="muted">Set up now: profile <b>' + esc(S.machine.NUCLEAR_AI_PROFILE) + '</b>.</div>' : '';
    out = '<h2>This machine</h2><div>' + esc(h.cpu) + ' · ' + h.cores + ' threads · <b>' + h.ram + ' GB</b> of memory · ' + esc(h.gpu ? h.gpu + (h.vram ? ' (' + h.vram + ' GB)' : '') : 'no GPU with memory of its own') + ' · ' + h.disk + ' GB of disk free</div>' + was
      + '<h2>Where do the agents run?</h2>'
      + '<div class="card ' + (local ? 'on' : '') + '" data-local="1"><h3>On this machine<span class="badge best">Suggested: it saves tokens</span></h3><div>Small local models write the code, the tests and the reviews; the Smart Graph gives them (and your remote agent) the knowledge of NuclearLang. A remote agent such as Claude Code then only leads, validates and corrects. Private: nothing leaves this machine.</div></div>'
      + '<div class="card ' + (local ? '' : 'on') + '" data-local="0"><h3>Remote agents only</h3><div>' + esc(S.profiles.find((p) => p.id === 'remote').summary) + '</div></div>'
      + (local ? '' : profileCard(S.profiles.find((p) => p.id === 'remote'), false))
      + '<div class="nav"><button class="primary" data-go="' + (local ? 1 : 2) + '">Next</button></div>';
  } else if (page === 1) {
    out = '<h2>Which models?</h2><div class="muted">Three sets, from the lightest to the most capable. The one suggested is the heaviest that runs well with ' + h.ram + ' GB of memory; the choice is yours.</div>'
      + S.profiles.filter((p) => p.coder).map((p) => profileCard(p, true)).join('')
      + '<div class="nav"><button data-go="0">Back</button><button class="primary" data-go="2"' + (profile ? '' : ' disabled') + '>Next</button></div>';
  } else if (page === 2) {
    const all = needs();
    out = '<h2>What it needs</h2><div class="muted">Checked every few seconds: install what is missing and this page sees it.</div>'
      + all.map((r) => '<div class="card plain"><div class="row"><span class="' + (r.found ? 'ok' : 'bad') + '">' + (r.found ? '✓' : '✗') + '</span><div class="grow"><b>' + esc(r.title) + '</b> <span class="muted">' + esc(r.why) + '</span><div class="line">' + esc(r.detail) + '</div>'
        + (!r.found && r.note && r.note[S.platform] ? '<div class="muted">' + esc(r.note[S.platform]) + '</div>' : '') + '</div>'
        + (r.found ? '' : (r.install[S.platform] && !r.detail.startsWith('installed, not running') ? '<button class="primary" data-install="' + r.id + '" title="' + esc(r.install[S.platform]) + '">Install it for me</button>' : '') + '<button data-open="' + esc(r.url) + '">I will install it</button>')
        + '</div></div>').join('')
      + (local && all.some((r) => r.local && !r.found) ? '<div class="muted">Without Ollama there are no local agents: <a data-remote="1">use remote agents only</a> (every line is then paid tokens).</div>' : '')
      + '<div class="nav"><button data-go="' + (local ? 1 : 0) + '">Back</button><button class="primary" data-go="3"' + (all.every((r) => r.found) ? '' : ' disabled') + '>Next</button></div>';
  } else {
    const p = chosen();
    if (!run) {
      out = '<h2>Ready to install</h2>' + profileCard(p, false)
        + '<div class="nav"><button data-go="2">Back</button><button class="primary" data-run="0">Install' + (p.gb ? ' (downloads up to ' + p.gb + ' GB)' : '') + '</button></div>';
    } else {
      const mark = { running: '…', done: '✓', failed: '✗' };
      out = '<h2>' + (run.done ? 'Done' : run.failed !== null ? 'A step failed' : 'Installing: leave this page open') + '</h2>'
        + run.titles.map((t, i) => { const st = run.status[i]; return '<div class="card plain"><div class="row"><span class="' + (st === 'done' ? 'ok' : st === 'failed' ? 'bad' : '') + '">' + (mark[st] || '·') + '</span><div class="grow"><b>' + esc(t) + '</b><div class="line ' + (st === 'failed' ? 'bad' : '') + '">' + esc(run.line[i] || '') + '</div></div>' + (st === 'failed' ? '<button class="primary" data-run="' + i + '">Try again</button>' : '') + '</div></div>'; }).join('')
        + (run.done ? '<div>' + (run.local ? 'The Smart Graph and the Nuclear Developer run on this machine, now and at every login, with the profile <b>' + esc(run.profile) + '</b>.' : 'The Nuclear MCP server is installed.') + ' Add it to Claude Code, Codex, Cursor or OpenCode in Settings and integrations.</div><div class="nav"><button class="primary" data-settings="1">Open Settings and integrations</button></div>' : '');
    }
  }
  document.getElementById('root').innerHTML = out;
  clearInterval(timer);
  if (page === 2) timer = setInterval(() => vscode.postMessage({ type: 'check' }), 3000);
}

document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-go],[data-local],[data-profile],[data-install],[data-open],[data-remote],[data-run],[data-settings]'); if (!d || d.disabled) return;
  if (d.dataset.go) page = Number(d.dataset.go);
  else if (d.dataset.local) local = d.dataset.local === '1';
  else if (d.dataset.profile) profile = d.dataset.profile;
  else if (d.dataset.remote) { local = false; page = 2; }
  else if (d.dataset.install) return vscode.postMessage({ type: 'install', id: d.dataset.install });
  else if (d.dataset.open) return vscode.postMessage({ type: 'open', url: d.dataset.open });
  else if (d.dataset.settings) return vscode.postMessage({ type: 'settings' });
  else if (d.dataset.run) { vscode.postMessage({ type: 'go', profile: chosen().id, from: Number(d.dataset.run) }); return; }
  draw();
});
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') {
    const first = !S; S = m;
    if (first) { const was = S.machine.NUCLEAR_AI_PROFILE; local = was !== 'remote'; profile = was && was !== 'remote' ? was : S.suggested === 'remote' ? '' : S.suggested; }
    if (first || page === 2) draw();
  } else if (m.type === 'steps') {
    run = run && m.from ? { ...run, failed: null } : { titles: m.titles, status: [], line: [], failed: null, done: false };
    draw();
  } else if (m.type === 'step') {
    run.status[m.index] = m.status; if (m.line || m.status === 'failed') run.line[m.index] = m.line; if (m.status === 'failed') run.failed = m.index;
    draw();
  } else if (m.type === 'done') { run.done = true; run.profile = m.profile; run.local = m.local; draw(); }
});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
