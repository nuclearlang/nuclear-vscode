// A component of the HTTP workspace (ADR-0099): one editor tab per component (like a Bruno folder), with one inner
// tab per endpoint opened from the tree; each inner tab keeps its request (method, url with path and query
// parameters, headers, body) and its last response. Requests are sent by the extension host (fetch) with the active
// environment's variables and headers. The webview's state is sent to the host on every change, so a panel closed by a
// workspace switch comes back as it was. Plain HTML and script, no framework.

import * as vscode from 'vscode';
import { componentKey, Endpoint, HttpModel } from './http';

interface RequestMessage {
  type: 'send';
  tab: number;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}
type Message = RequestMessage | { type: 'state'; state: unknown } | { type: 'editEnvironments' | 'selectEnvironment' };

export class ComponentPanel {
  private static readonly open_ = new Map<string, ComponentPanel>();
  private readonly panel: vscode.WebviewPanel;

  private constructor(
    context: vscode.ExtensionContext,
    private readonly model: HttpModel,
    readonly key: string,
    title: string,
  ) {
    this.panel = vscode.window.createWebviewPanel('nuclear.httpComponent', title, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icons', 'nuc-file.svg');
    this.panel.webview.html = html(this.panel.webview);
    const listener = model.onDidChange(() => this.environments());
    this.panel.onDidDispose(() => {
      ComponentPanel.open_.delete(key);
      listener.dispose();
    });
    this.panel.webview.onDidReceiveMessage((m: Message) => {
      if (m.type === 'send') void this.send(m);
      if (m.type === 'state') model.memory.set(key, { key, title, state: m.state });
      if (m.type === 'editEnvironments') void model.editEnvironments();
      if (m.type === 'selectEnvironment') void model.selectEnvironment();
    });
    ComponentPanel.open_.set(key, this);
    this.environments();
    const saved = model.memory.get(key);
    if (saved) void this.panel.webview.postMessage({ type: 'restore', state: saved.state });
  }

  /** The endpoint's component panel, created or revealed, with the endpoint as its active inner tab. */
  static open(context: vscode.ExtensionContext, model: HttpModel, endpoint: Endpoint): void {
    const key = componentKey(endpoint);
    const title = `${endpoint.component} · ${endpoint.kind === 'openapi' ? 'OpenAPI' : endpoint.project.split('/').pop()}`;
    const p = ComponentPanel.open_.get(key) ?? new ComponentPanel(context, model, key, title);
    p.panel.reveal(vscode.ViewColumn.Active);
    void p.panel.webview.postMessage({ type: 'open', endpoint });
  }

  static openKeys(): string[] {
    return [...ComponentPanel.open_.keys()];
  }

  /** Reopens the panels of `keys` from their memory (the HTTP workspace entered again). */
  static restore(context: vscode.ExtensionContext, model: HttpModel, keys: string[]): void {
    for (const key of keys) {
      const saved = model.memory.get(key);
      if (saved && !ComponentPanel.open_.has(key)) new ComponentPanel(context, model, key, saved.title);
    }
  }

  private environments(): void {
    const envs = this.model.environments();
    const env = envs.environments[envs.active];
    void this.panel.webview.postMessage({ type: 'environments', active: envs.active, names: Object.keys(envs.environments), vars: env?.vars ?? {}, headers: env?.headers ?? {}, baseUrls: env?.baseUrls ?? {} });
  }

  private async send(m: RequestMessage): Promise<void> {
    const envs = this.model.environments();
    const env = envs.environments[envs.active];
    const vars = env?.vars ?? {};
    const resolve = (s: string) => s.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}/g, (all, name: string) => vars[name] ?? all);
    const url = resolve(m.url);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(env?.headers ?? {})) headers[k] = resolve(v);
    for (const [k, v] of Object.entries(m.headers)) if (k.trim()) headers[k.trim()] = resolve(v);
    const body = m.body.trim() ? resolve(m.body) : undefined;
    if (body !== undefined && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['content-type'] = 'application/json';
    const started = Date.now();
    try {
      const res = await fetch(url, { method: m.method, headers, body, signal: AbortSignal.timeout(30_000) });
      const text = await res.text();
      void this.panel.webview.postMessage({
        type: 'response',
        tab: m.tab,
        ok: res.ok,
        status: res.status,
        statusText: res.statusText,
        ms: Date.now() - started,
        headers: Object.fromEntries(res.headers.entries()),
        body: text,
        url,
      });
    } catch (e) {
      void this.panel.webview.postMessage({ type: 'response', tab: m.tab, error: String(e), ms: Date.now() - started, url });
    }
  }
}

function html(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2);
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); overflow: hidden; }
  .bar { display: flex; align-items: stretch; gap: 0; flex: none; background: var(--vscode-editorGroupHeader-tabsBackground); border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, var(--vscode-widget-border, transparent)); overflow-x: auto; }
  .t { display: flex; align-items: center; gap: 6px; padding: 0 8px 0 12px; height: 32px; cursor: pointer; border-right: 1px solid var(--vscode-tab-border, transparent); white-space: nowrap; opacity: .75; font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .t.on { opacity: 1; background: var(--vscode-tab-activeBackground, var(--vscode-editor-background)); box-shadow: inset 0 -1px 0 var(--vscode-tab-activeBorder, var(--vscode-focusBorder)); }
  .t .x { opacity: .5; padding: 0 2px; border-radius: 3px; } .t .x:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .verb { font-weight: 700; font-size: 11px; }
  .verb.get { color: var(--vscode-nuclearHttp-get); } .verb.post { color: var(--vscode-nuclearHttp-post); } .verb.put { color: var(--vscode-nuclearHttp-put); } .verb.patch { color: var(--vscode-nuclearHttp-patch); } .verb.delete { color: var(--vscode-nuclearHttp-delete); }
  .env { margin-left: auto; display: flex; align-items: center; gap: 6px; padding: 0 10px; font-size: 11px; opacity: .8; white-space: nowrap; }
  .env a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  main { flex: 1; min-height: 0; overflow: auto; padding: 10px 16px; }
  .row { display: flex; gap: 6px; align-items: center; margin-bottom: 8px; }
  select, input, textarea, button { font-family: var(--vscode-editor-font-family); font-size: 12px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); padding: 4px 6px; border-radius: 2px; }
  input.url { flex: 1; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; cursor: pointer; padding: 5px 12px; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  h3 { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; margin: 12px 0 4px; }
  table { border-collapse: collapse; width: 100%; } td { padding: 2px 4px 2px 0; } td input { width: 100%; box-sizing: border-box; }
  textarea { width: 100%; box-sizing: border-box; min-height: 120px; resize: vertical; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px; overflow: auto; max-height: 50vh; font-size: 12px; margin: 0; }
  .status { font-weight: 600; } .ok { color: var(--vscode-testing-iconPassed); } .fail { color: var(--vscode-testing-iconFailed); }
  .muted { opacity: .7; font-size: 11px; }
  .desc { margin: 0 0 8px; opacity: .85; min-height: 1.2em; }
  .tabs { display: flex; gap: 10px; margin: 8px 0 4px; }
  .tabs span { cursor: pointer; opacity: .6; } .tabs span.on { opacity: 1; border-bottom: 1px solid var(--vscode-focusBorder); }
  .tab { display: none; } .tab.on { display: block; }
  .empty { opacity: .7; padding: 24px 0; text-align: center; }
</style>
</head>
<body>
<div class="bar"><div id="tabsBar" style="display:flex"></div><div class="env">env <b id="envName"></b> · <a id="pickEnv">change</a> · <a id="editEnv">edit</a></div></div>
<main id="main">
  <div class="empty" id="empty">Open an endpoint from the tree of the HTTP workspace: it becomes a tab here.</div>
  <div id="form" style="display:none">
    <p class="desc" id="desc"></p>
    <div class="row">
      <select id="method"><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select>
      <input class="url" id="url" placeholder="{{baseUrl}}/path">
      <button id="send">Send</button>
    </div>
    <div class="muted">variables: <span id="vars"></span></div>
    <div class="tabs"><span class="on" data-tab="params">Params</span><span data-tab="headers">Headers</span><span data-tab="body">Body</span></div>
    <div class="tab on" id="tab-params"><h3>Path</h3><table id="pathParams"></table><h3>Query</h3><table id="queryParams"></table></div>
    <div class="tab" id="tab-headers"><table id="headers"></table><button class="secondary" id="addHeader">+ header</button></div>
    <div class="tab" id="tab-body"><textarea id="body" placeholder="JSON body"></textarea></div>
    <h3>Response</h3>
    <div class="row"><span class="status" id="status">—</span><span class="muted" id="meta"></span><button class="secondary" id="copyCurl">copy as curl</button></div>
    <pre id="response"></pre>
    <details><summary class="muted">response headers</summary><pre id="responseHeaders"></pre></details>
  </div>
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let envs = { active: 'local', names: [], vars: {}, headers: {}, baseUrls: {} };
  // tabs: [{ endpoint, form: { method, url, path: {name: value}, query: {...}, headers: [[k, v]], body, pane }, response }]
  let tabs = [], active = -1, saveTimer;
  const el = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text !== undefined) d.textContent = text; return d; };
  const keyOf = (e) => e.verb + ' ' + e.path + ' ' + e.owner;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { if (active >= 0) tabs[active].form = readForm(); vscode.postMessage({ type: 'state', state: { tabs, active } }); }, 150); }

  function baseOf(e) { return envs.baseUrls[e.connection || ''] || envs.baseUrls[e.project] || '{{baseUrl}}'; }
  function sample(t) { t = t.replace(/\\?$/, ''); return t === 'int' || t === 'number' || t === 'double' || t === 'integer' ? '1' : t === 'boolean' || t === 'bool' ? 'true' : ''; }
  function newForm(e) {
    const path = {}, query = {};
    for (const p of e.params) if (p.in === 'path') path[p.name] = sample(p.type); else if (p.in === 'query') query[p.name] = p.default !== undefined ? String(p.default) : '';
    return { method: e.verb.toUpperCase(), url: '', path, query, headers: Object.entries(envs.headers), body: e.body !== undefined ? JSON.stringify(e.body, null, 2) : '', pane: e.body !== undefined ? 'body' : 'params' };
  }
  function rows(table, items) {
    table.innerHTML = '';
    for (const it of items) {
      const tr = el('tr'); const td = el('td', 'muted', it.label); td.style.width = '30%'; const td2 = el('td'); const i = el('input'); i.dataset.name = it.name; i.value = it.value ?? ''; td2.appendChild(i); tr.append(td, td2); table.appendChild(tr);
    }
    if (!items.length) table.innerHTML = '<tr><td class="muted">none</td></tr>';
  }
  function addHeader(k, v) {
    const tr = el('tr'); const a = el('td'); a.style.width = '30%'; const ia = el('input'); ia.placeholder = 'Name'; ia.value = k ?? ''; a.appendChild(ia);
    const b = el('td'); const ib = el('input'); ib.placeholder = 'Value'; ib.value = v ?? ''; b.appendChild(ib); tr.append(a, b); $('headers').appendChild(tr);
  }
  function showPane(name) {
    document.querySelectorAll('.tabs span').forEach((s) => s.classList.toggle('on', s.dataset.tab === name));
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.id === 'tab-' + name));
  }
  function buildUrl() {
    const t = tabs[active]; if (!t) return;
    let p = t.endpoint.path;
    for (const i of $('pathParams').querySelectorAll('input')) p = p.replace('{' + i.dataset.name + '}', encodeURIComponent(i.value));
    const q = [];
    for (const i of $('queryParams').querySelectorAll('input')) if (i.value !== '') q.push(encodeURIComponent(i.dataset.name) + '=' + encodeURIComponent(i.value));
    $('url').value = baseOf(t.endpoint).replace(/\\/$/, '') + p + (q.length ? '?' + q.join('&') : '');
  }
  function readForm() {
    const f = tabs[active].form;
    f.method = $('method').value; f.url = $('url').value; f.body = $('body').value;
    f.path = {}; for (const i of $('pathParams').querySelectorAll('input')) f.path[i.dataset.name] = i.value;
    f.query = {}; for (const i of $('queryParams').querySelectorAll('input')) f.query[i.dataset.name] = i.value;
    f.headers = []; for (const tr of $('headers').querySelectorAll('tr')) { const [k, v] = tr.querySelectorAll('input'); if (k) f.headers.push([k.value, v ? v.value : '']); }
    f.pane = document.querySelector('.tabs span.on')?.dataset.tab || 'params';
    return f;
  }
  function showResponse(r) {
    if (!r) { $('status').textContent = '—'; $('status').className = 'status'; $('meta').textContent = ''; $('response').textContent = ''; $('responseHeaders').textContent = ''; return; }
    if (r.error) { $('status').textContent = 'failed'; $('status').className = 'status fail'; $('response').textContent = r.error; $('meta').textContent = r.ms + ' ms · ' + r.url; $('responseHeaders').textContent = ''; return; }
    $('status').textContent = r.status + ' ' + r.statusText; $('status').className = 'status ' + (r.ok ? 'ok' : 'fail');
    $('meta').textContent = r.ms + ' ms · ' + r.body.length + ' bytes · ' + r.url;
    let text = r.body; try { text = JSON.stringify(JSON.parse(r.body), null, 2); } catch {}
    $('response').textContent = text;
    $('responseHeaders').textContent = Object.entries(r.headers).map(([k, v]) => k + ': ' + v).join('\\n');
  }
  function show(i) {
    if (active >= 0 && tabs[active]) tabs[active].form = readForm();
    active = i;
    const t = tabs[i];
    $('empty').style.display = t ? 'none' : ''; $('form').style.display = t ? '' : 'none';
    renderTabs();
    if (!t) { save(); return; }
    const e = t.endpoint, f = t.form;
    $('desc').textContent = (e.description ? e.description + ' · ' : '') + (e.owner ? e.owner + ' · ' : '') + (e.returns ? 'returns ' + e.returns : '');
    $('method').value = f.method;
    rows($('pathParams'), e.params.filter((p) => p.in === 'path').map((p) => ({ label: p.name + ': ' + p.type, name: p.name, value: f.path[p.name] })));
    rows($('queryParams'), e.params.filter((p) => p.in === 'query').map((p) => ({ label: p.name + (p.optional ? '?' : '') + ': ' + p.type, name: p.name, value: f.query[p.name] })));
    $('headers').innerHTML = ''; for (const [k, v] of f.headers) addHeader(k, v);
    $('body').value = f.body;
    $('vars').textContent = Object.keys(envs.vars).map((k) => '{{' + k + '}}').join(' ') || 'none';
    if (f.url) $('url').value = f.url; else buildUrl();
    showPane(f.pane);
    showResponse(t.response);
    save();
  }
  function renderTabs() {
    const bar = $('tabsBar'); bar.innerHTML = '';
    tabs.forEach((t, i) => {
      const d = el('div', 't' + (i === active ? ' on' : ''));
      d.appendChild(el('span', 'verb ' + t.endpoint.verb.toLowerCase(), t.endpoint.verb.toUpperCase()));
      d.appendChild(el('span', '', t.endpoint.path));
      const x = el('span', 'x', '×'); x.title = 'Close'; x.addEventListener('click', (ev) => { ev.stopPropagation(); close(i); }); d.appendChild(x);
      d.title = t.endpoint.owner; d.addEventListener('click', () => show(i)); bar.appendChild(d);
    });
  }
  function close(i) { tabs.splice(i, 1); if (active >= i) active = Math.max(-1, active - 1); const a = active; active = -1; show(Math.min(a, tabs.length - 1) < 0 && tabs.length ? 0 : a); }
  function open(e) {
    const i = tabs.findIndex((t) => keyOf(t.endpoint) === keyOf(e));
    if (i >= 0) return show(i);
    tabs.push({ endpoint: e, form: newForm(e), response: null });
    show(tabs.length - 1);
  }
  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'environments') { envs = m; $('envName').textContent = m.active; $('vars').textContent = Object.keys(m.vars).map((k) => '{{' + k + '}}').join(' ') || 'none'; }
    if (m.type === 'open') open(m.endpoint);
    if (m.type === 'restore' && m.state && m.state.tabs) { tabs = m.state.tabs; active = -1; show(m.state.active >= 0 && m.state.active < tabs.length ? m.state.active : tabs.length ? 0 : -1); }
    if (m.type === 'response') { const t = tabs[m.tab]; if (t) { t.response = m; if (m.tab === active) showResponse(m); save(); } }
  });
  document.addEventListener('input', (ev) => { if (ev.target.closest('#pathParams, #queryParams')) buildUrl(); save(); });
  document.addEventListener('change', save);
  document.querySelectorAll('.tabs span').forEach((s) => s.addEventListener('click', () => { showPane(s.dataset.tab); save(); }));
  $('addHeader').addEventListener('click', () => { addHeader('', ''); save(); });
  $('editEnv').addEventListener('click', () => vscode.postMessage({ type: 'editEnvironments' }));
  $('pickEnv').addEventListener('click', () => vscode.postMessage({ type: 'selectEnvironment' }));
  $('send').addEventListener('click', () => {
    const f = readForm();
    $('status').textContent = 'sending…'; $('status').className = 'status';
    vscode.postMessage({ type: 'send', tab: active, method: f.method, url: f.url, headers: Object.fromEntries(f.headers.filter(([k]) => k.trim())), body: f.body });
  });
  $('copyCurl').addEventListener('click', () => {
    const f = readForm();
    const h = f.headers.filter(([k]) => k.trim()).map(([k, v]) => " -H '" + k + ': ' + v + "'").join('');
    const b = f.body.trim() ? " -d '" + f.body.replace(/'/g, "'\\\\''") + "'" : '';
    navigator.clipboard.writeText('curl -X ' + f.method + h + b + " '" + f.url + "'");
  });
</script>
</body>
</html>`;
}
