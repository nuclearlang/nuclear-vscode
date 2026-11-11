// The web device: a web app of the Dragonfly web platform shown in the editor, beside its code, the way the Dragonfly
// device shows a mobile app (ADR-0099). The page runs in a headless browser (webSession.ts) at the size of a desktop,
// a laptop, a tablet or a phone; the panel adds what a web developer needs: the address bar, the color scheme, the
// network throttling, the cache, the page's console and requests, a screenshot, Chrome's DevTools and the debugger
// (VS Code's JavaScript debugger attached to the same page: a breakpoint in a .nuc stops there).
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isInstalled, readCard } from './card';
import { ConsoleEntry, NetworkEntry, WEB_PRESETS, WebSession, WebView } from './webSession';

const STATE_KEY = 'nuclear.webDevice.view';

export interface WebApp {
  root: string; // the project (its .nuc)
  app: string; // the generated app (the card's output)
  dragonfly: string; // the dragonfly binary
  name: string;
  serve?: string; // the dialect's toolchain.serve (from the project card)
}

const panels = new Map<string, WebDevicePanel>(); // by project root
let ctx: vscode.ExtensionContext;
let output: vscode.OutputChannel;

/** `dragonfly <args>` in the project, its output in the channel; resolves to the exit code. */
function dragonfly(app: WebApp, args: string[]): Promise<number> {
  return new Promise((done) => {
    output.appendLine(`$ dragonfly ${args.join(' ')}`);
    execFile(app.dragonfly, args, { cwd: app.root, env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      output.append(stdout + stderr);
      done(err ? (typeof err.code === 'number' ? err.code : 1) : 0);
    });
  });
}

class WebDevicePanel {
  readonly panel: vscode.WebviewPanel;
  session?: WebSession;
  private view: WebView;
  private debugging?: vscode.DebugSession;
  private density = 1;

  constructor(readonly app: WebApp) {
    this.view = { ...{ preset: 'Responsive', width: 1280, height: 800, landscape: false, scheme: 'system', throttle: 'none', noCache: false }, ...ctx.globalState.get<Partial<WebView>>(STATE_KEY, {}) } as WebView;
    this.panel = vscode.window.createWebviewPanel('nuclear.webDevice', `Web · ${app.name}`, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.iconPath = vscode.Uri.joinPath(ctx.extensionUri, 'icons', 'platform-web.svg');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => this.stop(true));
    this.panel.webview.onDidReceiveMessage((m) => void this.message(m));
  }

  private post(m: object): void {
    void this.panel.webview.postMessage(m);
  }

  /** Builds and installs the app when needed, serves it and opens it at the panel's viewport. */
  async start(): Promise<void> {
    this.stop(false);
    this.post({ type: 'starting', text: 'Building the app…' });
    if ((await dragonfly(this.app, ['build'])) !== 0) return this.failed('the build failed (see the Web device output)');
    if (!isInstalled(this.app.root)) {
      this.post({ type: 'starting', text: 'Installing the packages (once)…' });
      if ((await dragonfly(this.app, ['install'])) !== 0) return this.failed('dragonfly install failed (see the Web device output)');
    }
    this.post({ type: 'starting', text: 'Starting the dev server and the browser…' });
    const s = (this.session = new WebSession(this.app.app, readCard(this.app.root)?.toolchain?.serve ?? this.app.serve, {
      frame: (data) => this.post({ type: 'frame', data }),
      console: (e: ConsoleEntry) => this.post({ type: 'console', entry: e }),
      network: (e: NetworkEntry) => this.post({ type: 'network', entry: e }),
      address: (url, canBack, canForward) => this.post({ type: 'address', url, canBack, canForward }),
      log: (line) => output.appendLine(line),
    }));
    try {
      await s.start(this.view, this.density);
      this.post({ type: 'live', url: s.url });
    } catch (e) {
      s.stop();
      this.failed(e instanceof Error ? e.message : String(e));
    }
  }

  private failed(message: string): void {
    this.post({ type: 'failed', message });
  }

  stop(disposed: boolean): void {
    if (this.debugging) void vscode.debug.stopDebugging(this.debugging);
    this.debugging = undefined;
    this.session?.stop();
    this.session = undefined;
    if (disposed) panels.delete(this.app.root);
    else this.post({ type: 'stopped' });
  }

  /** VS Code's JavaScript debugger on the page: breakpoints in the generated .ts, and in the .nuc through the
   * line map (debug.ts mirrors them and shows the paused .nuc line). */
  async debug(): Promise<void> {
    if (!this.session) await this.start();
    const s = this.session;
    if (!s?.cdpPort) return;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this.app.root));
    const ok = await vscode.debug.startDebugging(folder, {
      type: 'chrome',
      request: 'attach',
      name: `${this.app.name} · web device`,
      port: s.cdpPort,
      webRoot: this.app.app,
      urlFilter: `${s.url}*`,
    });
    if (ok) this.debugging = vscode.debug.activeDebugSession;
    this.post({ type: 'debugging', on: ok });
  }

  reveal(): void {
    this.panel.reveal(undefined, true);
  }

  private async message(m: { type: string; [k: string]: unknown }): Promise<void> {
    const s = this.session;
    switch (m.type) {
      case 'view': {
        this.view = m.view as WebView;
        void ctx.globalState.update(STATE_KEY, this.view);
        await s?.emulate(this.view, this.density).catch(() => undefined);
        break;
      }
      case 'density':
        this.density = Math.min(3, Math.max(1, Number(m.value) || 1));
        await s?.emulate(this.view, this.density).catch(() => undefined);
        break;
      case 'input':
        await s?.input(m.input as never).catch(() => undefined);
        break;
      case 'go':
        await s?.go(String(m.address)).catch(() => undefined);
        break;
      case 'reload':
        await s?.reload(m.hard === true).catch(() => undefined);
        break;
      case 'back':
        await s?.history(-1).catch(() => undefined);
        break;
      case 'forward':
        await s?.history(1).catch(() => undefined);
        break;
      case 'run':
        await this.start();
        break;
      case 'stop':
        this.stop(false);
        break;
      case 'debug':
        await this.debug();
        break;
      case 'external':
        if (s) await vscode.env.openExternal(vscode.Uri.parse(String(m.url ?? s.url)));
        break;
      case 'devtools': {
        const url = await s?.devtoolsUrl().catch(() => undefined);
        if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
        break;
      }
      case 'screenshot': {
        const png = await s?.screenshot().catch(() => undefined);
        if (!png) break;
        const dir = path.join(this.app.root, 'build', 'screenshots');
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${this.view.preset.replace(/\W+/g, '-').toLowerCase()}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
        fs.writeFileSync(file, Buffer.from(png, 'base64'));
        await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Active, preview: true });
        break;
      }
      case 'open': {
        // a console line's `url:line` of the generated code: open it (debug.ts' "other side" maps it to the .nuc)
        const [, rel, line] = /^https?:\/\/[^/]+\/(.+?)(?:\?[^:]*)?:(\d+)$/.exec(String(m.source)) ?? [];
        const file = rel && path.join(this.app.app, rel);
        if (file && fs.existsSync(file)) {
          const doc = await vscode.workspace.openTextDocument(file);
          const at = new vscode.Position(Math.max(0, Number(line) - 1), 0);
          await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, selection: new vscode.Range(at, at) });
        }
        break;
      }
    }
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    const presets = JSON.stringify(WEB_PRESETS.map((p) => ({ name: p.name, width: p.width, height: p.height, kind: p.kind })));
    const state = JSON.stringify(this.view);
    return /* html */ `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<style>
:root { --line: var(--vscode-panel-border, #4446); }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); font: 12px var(--vscode-font-family); background: var(--vscode-editor-background); }
.bar { display: flex; align-items: center; gap: 5px; height: 32px; padding: 0 8px; background: var(--vscode-editorWidget-background); border-bottom: 1px solid var(--line); white-space: nowrap; overflow-x: auto; }
.sep { width: 1px; height: 18px; background: var(--line); margin: 0 3px; }
.grow { flex: 1; }
select, input { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; height: 22px; font: inherit; }
input.num { width: 52px; text-align: center; }
#address { flex: 1; min-width: 140px; padding: 0 8px; }
label { display: inline-flex; align-items: center; gap: 3px; opacity: .85; }
button { display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 24px; padding: 0 4px; border: 0; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; font: inherit; }
button:hover { background: var(--vscode-toolbar-hoverBackground); }
button:disabled { opacity: .35; cursor: default; background: transparent; }
button.on { color: var(--vscode-debugIcon-startForeground, #89d185); }
button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
#main { position: absolute; top: 64px; left: 0; right: 0; bottom: 0; display: flex; flex-direction: column; }
#stage { flex: 1; min-height: 80px; overflow: auto; display: grid; place-items: center; background: var(--vscode-sideBar-background); outline: none; }
#scaler { transform-origin: top left; }
#device { position: relative; display: inline-block; vertical-align: top; }
#device.phone { padding: 40px 14px 14px; border-radius: 46px; background: #111; box-shadow: 0 0 0 2px #3a3a3a, 0 12px 40px #0008; }
#device.phone::before { content: ''; position: absolute; top: 11px; left: 50%; width: 90px; height: 20px; margin-left: -45px; border-radius: 12px; background: #000; }
#device.phone.landscape { padding: 14px 14px 14px 40px; }
#device.phone.landscape::before { top: 50%; left: 11px; width: 20px; height: 90px; margin: -45px 0 0; }
#device.tablet { padding: 22px; border-radius: 30px; background: #111; box-shadow: 0 0 0 2px #3a3a3a, 0 12px 40px #0008; }
#device.desktop { padding: 26px 0 0; border-radius: 8px; background: #2b2b2b; box-shadow: 0 0 0 1px var(--line), 0 8px 30px #0006; }
#device.desktop::before { content: '● ● ●'; position: absolute; top: 5px; left: 10px; color: #777; font-size: 10px; letter-spacing: 2px; }
#screen { position: relative; overflow: hidden; background: #fff; touch-action: none; user-select: none; }
#device.phone #screen { border-radius: 34px; }
#device.tablet #screen { border-radius: 10px; }
#app { display: block; width: 100%; height: 100%; pointer-events: none; }
#cover { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: calc(12px / var(--z, 1)); background: #1e1e1e; color: #ccc; text-align: center; padding: 20px; font-size: calc(13px / var(--z, 1)); }
#cover button.run { height: calc(28px / var(--z, 1)); padding: 0 calc(14px / var(--z, 1)); font-size: inherit; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.spin { width: calc(26px / var(--z, 1)); height: calc(26px / var(--z, 1)); border: calc(3px / var(--z, 1)) solid #555; border-top-color: #4fc3f7; border-radius: 50%; animation: s .9s linear infinite; }
@keyframes s { to { transform: rotate(360deg); } }
#dock { height: 34%; min-height: 28px; display: flex; flex-direction: column; border-top: 1px solid var(--line); background: var(--vscode-panel-background, var(--vscode-editor-background)); }
#dock.closed { height: 28px; flex: none; }
#dock .tabs { display: flex; align-items: center; gap: 2px; height: 28px; padding: 0 6px; border-bottom: 1px solid var(--line); cursor: row-resize; }
.tab { padding: 0 10px; height: 22px; border-radius: 4px; }
.tab.active { background: var(--vscode-tab-activeBackground, #fff1); font-weight: 600; }
.count { opacity: .6; margin-left: 4px; }
#filter { width: 160px; padding: 0 6px; }
.list { flex: 1; overflow: auto; font: 12px var(--vscode-editor-font-family); }
.row { display: flex; gap: 10px; padding: 2px 10px; border-bottom: 1px solid #8881; white-space: pre-wrap; word-break: break-word; }
.row .src { margin-left: auto; opacity: .6; white-space: nowrap; cursor: pointer; text-decoration: underline dotted; }
.row.warn { background: #cca70014; color: var(--vscode-editorWarning-foreground, #cca700); }
.row.error { background: #f1484814; color: var(--vscode-editorError-foreground, #f14848); }
.row.debug { opacity: .65; }
table { width: 100%; border-collapse: collapse; }
td, th { padding: 2px 8px; text-align: left; border-bottom: 1px solid #8881; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 480px; }
th { position: sticky; top: 0; background: var(--vscode-editorWidget-background); font-weight: 600; }
tr.bad td { color: var(--vscode-editorError-foreground, #f14848); }
td.n { text-align: right; opacity: .8; }
.hidden { display: none; }
</style></head><body>
<div class="bar">
  <button id="back" title="Back" disabled><svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5"/></svg></button>
  <button id="forward" title="Forward" disabled><svg viewBox="0 0 16 16"><path d="m6 3 5 5-5 5"/></svg></button>
  <button id="reload" title="Reload (Shift: without cache)"><svg viewBox="0 0 16 16"><path d="M13.5 8A5.5 5.5 0 1 1 11 3.4"/><path d="M11.5 1v3h-3"/></svg></button>
  <input id="address" spellcheck="false" placeholder="/ (an address of the app)">
  <button id="external" title="Open in the browser"><svg viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4"/></svg></button>
  <button id="devtools" title="Chrome DevTools of this page"><svg viewBox="0 0 16 16"><path d="m5.5 4.5-4 3.5 4 3.5M10.5 4.5l4 3.5-4 3.5"/></svg></button>
  <span class="sep"></span>
  <button id="debug" title="Debug: VS Code's debugger on the page (breakpoints in the .nuc)"><svg viewBox="0 0 16 16"><circle cx="8" cy="9" r="4"/><path d="M8 5V3M5 6 3 4M11 6l2-2M4 9H1.5M14.5 9H12M5 12l-2 2M11 12l2 2"/></svg></button>
  <button id="stop" title="Stop the dev server and the browser"><svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg></button>
</div>
<div class="bar">
  <select id="preset" title="Device"></select>
  <input id="w" class="num" type="number" min="200" max="4000" title="Width">
  <span>×</span>
  <input id="h" class="num" type="number" min="200" max="4000" title="Height">
  <button id="rotate" title="Rotate"><svg viewBox="0 0 16 16"><rect x="4" y="1.5" width="8" height="13" rx="1.5"/><path d="M14.5 6.5a6 6 0 0 0-3-4M1.5 9.5a6 6 0 0 0 3 4"/></svg></button>
  <select id="zoom" title="Zoom"><option value="fit">Fit</option><option value="0.5">50%</option><option value="0.75">75%</option><option value="1">100%</option></select>
  <span class="sep"></span>
  <select id="scheme" title="prefers-color-scheme"><option value="system">Theme: system</option><option value="light">Light</option><option value="dark">Dark</option></select>
  <select id="throttle" title="Network"><option value="none">No throttling</option><option value="fast-4g">Fast 4G</option><option value="slow-3g">Slow 3G</option><option value="offline">Offline</option></select>
  <label title="Disable the cache while the device runs"><input id="nocache" type="checkbox">No cache</label>
  <span class="grow"></span>
  <button id="screenshot" title="Screenshot (saved in build/screenshots)"><svg viewBox="0 0 16 16"><rect x="1.5" y="4" width="13" height="9.5" rx="1.5"/><circle cx="8" cy="8.7" r="2.5"/><path d="M5.5 4 6.5 2.5h3l1 1.5"/></svg></button>
</div>
<div id="main">
  <div id="stage" tabindex="0"><div id="scaler"><div id="device"><div id="screen"><img id="app" alt=""><div id="cover"></div></div></div></div></div>
  <div id="dock">
    <div class="tabs" id="tabs">
      <button class="tab active" data-tab="console">Console<span class="count" id="nconsole"></span></button>
      <button class="tab" data-tab="network">Network<span class="count" id="nnetwork"></span></button>
      <span class="grow"></span>
      <input id="filter" placeholder="Filter">
      <button id="clear" title="Clear"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.5"/><path d="m4 12 8-8"/></svg></button>
      <button id="fold" title="Hide or show the panel"><svg viewBox="0 0 16 16"><path d="m4 10 4-4 4 4"/></svg></button>
    </div>
    <div class="list" id="console"></div>
    <div class="list hidden" id="network"><table><thead><tr><th>Method</th><th>Status</th><th>Address</th><th>Type</th><th class="n">Size</th><th class="n">Time</th></tr></thead><tbody id="rows"></tbody></table></div>
  </div>
</div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const PRESETS = ${presets};
const st = ${state};
const $ = (id) => document.getElementById(id);
const preset = $('preset'), w = $('w'), h = $('h'), zoom = $('zoom'), img = $('app'), cover = $('cover');
const device = $('device'), screen = $('screen'), scaler = $('scaler'), stage = $('stage');
let groupOf = '';
for (const p of PRESETS) {
  const g = { desktop: 'Desktop', tablet: 'Tablets', phone: 'Phones' }[p.kind];
  let og = preset.querySelector('optgroup[label="' + g + '"]');
  if (!og) { og = document.createElement('optgroup'); og.label = g; preset.appendChild(og); }
  og.appendChild(new Option(p.name, p.name));
}
if (!PRESETS.some((p) => p.name === st.preset)) st.preset = 'Responsive';
preset.value = st.preset; zoom.value = st.zoom || 'fit'; $('scheme').value = st.scheme; $('throttle').value = st.throttle; $('nocache').checked = !!st.noCache;
let live = false, sent = '', base = '';
const current = () => PRESETS.find((p) => p.name === st.preset);
function size() {
  const p = current();
  const b = p.name === 'Responsive' ? [st.rw || p.width, st.rh || p.height] : [p.width, p.height];
  return st.landscape ? [b[1], b[0]] : b;
}
function layout() {
  const p = current(), [cw, ch] = size();
  w.value = cw; h.value = ch; w.disabled = h.disabled = p.name !== 'Responsive';
  device.className = p.kind + (st.landscape ? ' landscape' : '');
  screen.style.width = cw + 'px'; screen.style.height = ch + 'px';
  const pad = { phone: st.landscape ? [54, 28] : [28, 54], tablet: [44, 44], desktop: [0, 26] }[p.kind];
  let z = Number(st.zoom);
  if (!st.zoom || st.zoom === 'fit') z = Math.max(0.05, Math.min(1, (stage.clientWidth - 24) / (cw + pad[0]), (stage.clientHeight - 24) / (ch + pad[1])));
  scaler.style.transform = 'scale(' + z + ')'; scaler.style.width = (cw + pad[0]) * z + 'px'; scaler.style.height = (ch + pad[1]) * z + 'px';
  scaler.style.setProperty('--z', z);
  const view = { preset: p.name, width: cw, height: ch, landscape: !!st.landscape, scheme: st.scheme, throttle: st.throttle, noCache: !!st.noCache, zoom: st.zoom, rw: st.rw, rh: st.rh };
  const key = JSON.stringify(view);
  if (key !== sent) { sent = key; vscode.postMessage({ type: 'view', view }); }
  // the page is drawn with as many pixels as the panel shows it with: sharp at any zoom
  vscode.postMessage({ type: 'density', value: z * window.devicePixelRatio });
}
function setCover(html) { cover.innerHTML = html; cover.style.display = html ? 'flex' : 'none'; }
preset.onchange = () => { st.preset = preset.value; layout(); };
zoom.onchange = () => { st.zoom = zoom.value; layout(); };
w.onchange = () => { st.rw = Math.max(200, +w.value || 1280); layout(); };
h.onchange = () => { st.rh = Math.max(200, +h.value || 800); layout(); };
$('rotate').onclick = () => { st.landscape = !st.landscape; layout(); };
$('scheme').onchange = (e) => { st.scheme = e.target.value; layout(); };
$('throttle').onchange = (e) => { st.throttle = e.target.value; layout(); };
$('nocache').onchange = (e) => { st.noCache = e.target.checked; layout(); };
$('reload').onclick = (e) => vscode.postMessage({ type: 'reload', hard: e.shiftKey });
for (const id of ['back', 'forward', 'stop', 'debug', 'devtools', 'screenshot']) $(id).onclick = () => vscode.postMessage({ type: id });
$('external').onclick = () => vscode.postMessage({ type: 'external', url: base ? new URL($('address').value || '/', base).href : undefined });
$('address').onkeydown = (e) => { if (e.key === 'Enter') vscode.postMessage({ type: 'go', address: $('address').value }); };
new ResizeObserver(layout).observe(stage);

// input on the screen, in the page's CSS pixels whatever the zoom
function at(e) { const r = screen.getBoundingClientRect(), [cw, ch] = size(); return { x: (e.clientX - r.left) / r.width * cw, y: (e.clientY - r.top) / r.height * ch }; }
const send = (input) => vscode.postMessage({ type: 'input', input });
let down = false, queued = null;
screen.addEventListener('pointerdown', (e) => { if (!live || e.button !== 0) return; e.preventDefault(); stage.focus(); screen.setPointerCapture(e.pointerId); down = true; send({ kind: 'down', ...at(e) }); });
screen.addEventListener('pointermove', (e) => { if (!live || (!down && current().kind !== 'desktop')) return; if (!queued) requestAnimationFrame(() => { send({ kind: 'move', ...queued }); queued = null; }); queued = at(e); });
for (const t of ['pointerup', 'pointercancel']) screen.addEventListener(t, (e) => { if (!live || !down) return; down = false; send({ kind: t === 'pointerup' ? 'up' : 'cancel', ...at(e) }); });
screen.addEventListener('wheel', (e) => { if (!live) return; e.preventDefault(); send({ kind: 'wheel', ...at(e), dx: e.deltaX, dy: e.deltaY }); }, { passive: false });
const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
for (const t of ['keydown', 'keyup']) stage.addEventListener(t, (e) => { if (!live) return; e.preventDefault(); send({ kind: t === 'keydown' ? 'keyDown' : 'keyUp', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: mods(e) }); });

// the dock: console and network
const logs = [], reqs = new Map();
let tab = 'console';
for (const b of document.querySelectorAll('.tab')) b.onclick = () => { tab = b.dataset.tab; for (const x of document.querySelectorAll('.tab')) x.classList.toggle('active', x === b); $('console').classList.toggle('hidden', tab !== 'console'); $('network').classList.toggle('hidden', tab !== 'network'); };
$('fold').onclick = () => { $('dock').classList.toggle('closed'); layout(); };
$('clear').onclick = () => { if (tab === 'console') { logs.length = 0; $('console').innerHTML = ''; } else { reqs.clear(); $('rows').innerHTML = ''; } counts(); };
$('filter').oninput = () => { for (const r of document.querySelectorAll('.row, #rows tr')) r.classList.toggle('hidden', !match(r.textContent)); };
const match = (t) => !$('filter').value || t.toLowerCase().includes($('filter').value.toLowerCase());
const esc = (t) => String(t).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
function counts() { const errs = logs.filter((l) => l.level === 'error').length; $('nconsole').textContent = logs.length ? logs.length + (errs ? ' · ' + errs + ' errors' : '') : ''; $('nnetwork').textContent = reqs.size || ''; }
function addLog(e) {
  logs.push(e);
  const row = document.createElement('div');
  row.className = 'row ' + e.level;
  const list = $('console'), stick = list.scrollTop + list.clientHeight >= list.scrollHeight - 4;
  row.innerHTML = '<span>' + esc(e.text) + '</span>' + (e.source ? '<span class="src" title="Open the generated line">' + esc(e.source.replace(/^https?:\\/\\/[^/]+\\//, '')) + '</span>' : '');
  if (e.source) row.querySelector('.src').onclick = () => vscode.postMessage({ type: 'open', source: e.source });
  if (!match(row.textContent)) row.classList.add('hidden');
  list.appendChild(row);
  if (stick) list.scrollTop = list.scrollHeight;
  counts();
}
const kb = (n) => n == null ? '' : n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' kB';
function addReq(e) {
  let tr = reqs.get(e.id);
  if (!tr) { tr = document.createElement('tr'); reqs.set(e.id, tr); $('rows').appendChild(tr); }
  const u = new URL(e.url);
  tr.className = e.failed || (e.status >= 400) ? 'bad' : '';
  tr.title = e.url;
  tr.innerHTML = '<td>' + esc(e.method) + '</td><td>' + esc(e.failed || e.status || '…') + '</td><td>' + esc(u.origin === base.replace(/\\/$/, '') ? u.pathname + u.search : e.url) + '</td><td>' + esc(e.type) + '</td><td class="n">' + kb(e.size) + '</td><td class="n">' + (e.ms != null ? e.ms + ' ms' : '') + '</td>';
  if (!match(tr.textContent)) tr.classList.add('hidden');
  counts();
}

window.addEventListener('message', (ev) => {
  const m = ev.data;
  if (m.type === 'frame') { img.src = 'data:image/jpeg;base64,' + m.data; if (!live) { live = true; setCover(''); } }
  else if (m.type === 'console') addLog(m.entry);
  else if (m.type === 'network') addReq(m.entry);
  else if (m.type === 'address') {
    const u = new URL(m.url);
    if (document.activeElement !== $('address')) $('address').value = base && m.url.startsWith(base.replace(/\\/$/, '')) ? u.pathname + u.search + u.hash : m.url;
    $('back').disabled = !m.canBack; $('forward').disabled = !m.canForward;
  }
  else if (m.type === 'live') { base = m.url; sent = ''; layout(); }
  else if (m.type === 'debugging') $('debug').classList.toggle('on', !!m.on);
  else if (m.type === 'starting') { live = false; img.removeAttribute('src'); setCover('<div class="spin"></div><div>' + esc(m.text) + '</div>'); }
  else if (m.type === 'failed') setCover('<div>The web device could not show the app:<br><small>' + esc(m.message) + '</small></div><button class="run" id="run">▷ Try again</button>'), $('run').onclick = () => vscode.postMessage({ type: 'run' });
  else if (m.type === 'stopped') { live = false; img.removeAttribute('src'); $('debug').classList.remove('on'); setCover('<div>The app is not running on the web device.</div><button class="run" id="run">▷ Run</button>'); $('run').onclick = () => vscode.postMessage({ type: 'run' }); }
});
layout();
</script></body></html>`;
  }
}

/** The web app of a project: the generated app and the dragonfly binary, from the workspace `dragonfly build` writes. */
export type FindWebApp = (root: string) => WebApp | undefined;

/** Opens (or shows) the web device of a project and runs its app there. */
export async function openWebDevice(app: WebApp, debug = false): Promise<void> {
  let panel = panels.get(app.root);
  if (panel) panel.reveal();
  else {
    panel = new WebDevicePanel(app);
    panels.set(app.root, panel);
    await panel.start();
  }
  if (debug) await panel.debug();
}

export function reloadWebDevice(root: string): boolean {
  const s = panels.get(root)?.session;
  if (!s) return false;
  void s.reload();
  return true;
}

export function activateWebDevice(context: vscode.ExtensionContext, find: FindWebApp): void {
  ctx = context;
  output = vscode.window.createOutputChannel('Web device');
  const withApp = async (root: string | undefined, f: (app: WebApp) => Promise<void> | void) => {
    const app = root ? find(root) : undefined;
    if (!app) {
      void vscode.window.showInformationMessage('Not a web project with a build: run dragonfly build in it first.');
      return;
    }
    await f(app);
  };
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('nuclear.webDevice.open', (root?: string) => withApp(root, (a) => openWebDevice(a))),
    vscode.commands.registerCommand('nuclear.webDevice.debug', (root?: string) => withApp(root, (a) => openWebDevice(a, true))),
    vscode.commands.registerCommand('nuclear.webDevice.reload', (root?: string) => {
      if (!root || !reloadWebDevice(root)) void vscode.window.showInformationMessage('No web device runs this project (▭ Device opens one).');
    }),
    { dispose: () => [...panels.values()].forEach((p) => p.stop(true)) },
  );
}
