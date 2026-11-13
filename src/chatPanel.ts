// The Nuclear agent tool (Ctrl+Alt+A): a chat with the local agents of the Nuclear Developer, like the chats of
// Claude or Cursor, over the active project. A message is a question (the local assistant answers with the Smart
// Graph and the project's map, `POST /developer/chat`); `/task <what to do>` is an order (a Loop run with the local
// agents only; its journal comes back as the answer). Sessions are kept in the project (`.nuclear/chat/<id>.json`).
//
// The work does not belong to the page: a question or an order is a job of the extension (`jobs`), so closing the
// page or switching to another tool leaves it thinking; when it ends the answer is saved in its session and a
// notification says so (notifications.ts). The page only draws: the sessions, the answers with what the agent did
// folded in grey, the context window of the local model, the templates and the history of questions (↑ / ↓).
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { aiSettings, machineConfig } from './aiSettings';
import { readCard } from './card';
import { askedOf, CHAT_DIR, ChatMessage, ChatSession, historyOf, listSessions, MAP_LIMIT, saveSession, templatesOf, tokensOf } from './chat';
import { backoff, criteriaOf, DEFAULT_RETRY, listRuns, LoopEngine, newRun, readConfig, retryAfter, Run, RUNS_DIR, slug, Spec, transientStatus } from './loopEngine';
import { LoopProject } from './loopPanel';
import { notices } from './notifications';
import { checkForChat } from './connections';

type Message =
  | { type: 'ready' }
  | { type: 'project'; root: string }
  | { type: 'new' }
  | { type: 'open'; id: string }
  | { type: 'delete'; id: string }
  | { type: 'send'; text: string }
  | { type: 'ask'; index: number }
  | { type: 'stop' }
  | { type: 'retry'; run: string }
  | { type: 'file'; file: string };

/** A question or an order being worked on: what the page shows while it runs. */
interface Job {
  kind: 'ask' | 'task';
  started: number;
  lines: string[];
  abort?: AbortController;
  engine?: LoopEngine;
}

const jobs = new Map<string, Job>(); // by `<root>|<session id>`
const key = (root: string, id: string) => `${root}|${id}`;

function loadSession(root: string, id: string): ChatSession | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, CHAT_DIR, `${id}.json`), 'utf8')) as ChatSession;
  } catch {
    return undefined;
  }
}

/** Adds a message to a session on disk (the page may be closed) and redraws the page when it is open. */
function append(root: string, id: string, message: ChatMessage, title?: string): void {
  const s = loadSession(root, id) ?? { id, title: title ?? message.text.slice(0, 60), created: Date.now(), messages: [] };
  s.messages.push(message);
  saveSession(root, s);
  ChatPanel.refresh();
}

function mapOf(root: string): string {
  try {
    return fs.readFileSync(path.join(root, '.nuclear', 'map.md'), 'utf8');
  } catch {
    return '';
  }
}

/** A question to the local assistant, retried with backoff when the Developer is briefly down. */
async function ask(root: string, id: string, text: string): Promise<void> {
  const card = readCard(root);
  const config = readConfig(root, card?.platform ?? '', machineConfig());
  const policy = { ...DEFAULT_RETRY, ...config.retry };
  const job: Job = { kind: 'ask', started: Date.now(), lines: ['searching the Smart Graph and the project map, then writing the answer'], abort: new AbortController() };
  jobs.set(key(root, id), job);
  ChatPanel.refresh();
  // every connection it needs, before the question: a service down is said at once, with how to fix it
  const down = await checkForChat();
  if (down) {
    append(root, id, { role: 'agent', text: `Before asking, a connection does not answer:\n\n${down}`, at: Date.now(), failed: true, steps: ['checked the connections'], seconds: Math.round((Date.now() - job.started) / 1000) });
    jobs.delete(key(root, id));
    ChatPanel.refresh();
    return;
  }
  // the question was just added: the history is what came before it
  const history = historyOf((loadSession(root, id)?.messages ?? []).slice(0, -1));
  const body = JSON.stringify({ message: text, platform: card?.platform ?? 'backend', map: mapOf(root).slice(0, MAP_LIMIT), history, root });
  try {
    let data: { report?: string; trace?: { step: string; detail: string }[]; detail?: unknown } = {};
    for (let n = 1; ; n++) {
      let wait: number | undefined;
      try {
        const r = await fetch(config.developerUrl + '/developer/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: job.abort!.signal });
        data = (await r.json()) as typeof data;
        if (r.ok) break;
        if (!transientStatus(r.status) || n >= policy.attempts) throw new Error(`${r.status} ${JSON.stringify(data.detail ?? data)}`);
        wait = retryAfter(r.headers.get('retry-after'));
      } catch (e) {
        if ((e instanceof Error && e.name === 'AbortError') || n >= policy.attempts || !(e instanceof TypeError)) throw e;
      }
      const ms = backoff(n, policy, wait);
      job.lines.push(`the local developer did not answer: try ${n + 1} of ${policy.attempts} in ${(ms / 1000).toFixed(1)} s`);
      ChatPanel.refresh();
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    const trace = data.trace ?? [];
    const context = Number(trace.find((t) => t.step === 'context')?.detail ?? 0);
    const steps = [...job.lines.slice(1), ...trace.filter((t) => t.step !== 'context').map((t) => `${t.step}: ${t.detail}`)];
    append(root, id, { role: 'agent', text: (data.report ?? '').trim() || '(no answer)', at: Date.now(), steps, seconds: Math.round((Date.now() - job.started) / 1000), tokens: context ? tokensOf(context) : undefined });
    notices.add({ tool: 'agent', title: 'The local agent answered', text: text.slice(0, 80), level: 'info', root, ref: id });
  } catch (e) {
    const stopped = e instanceof Error && e.name === 'AbortError';
    const why = stopped ? 'stopped' : `the local developer did not answer at ${config.developerUrl} (${e instanceof Error ? e.message : e}): start it in Settings and integrations (Ctrl+Alt+S)`;
    append(root, id, { role: 'agent', text: why, at: Date.now(), failed: true, steps: job.lines, seconds: Math.round((Date.now() - job.started) / 1000) });
    if (!stopped) notices.add({ tool: 'agent', title: 'The local agent did not answer', text: text.slice(0, 80), level: 'error', root, ref: id });
  } finally {
    jobs.delete(key(root, id));
    ChatPanel.refresh();
  }
}

/** An order (or a retry of one): a Loop run of the local agents; each step is shown as it ends. */
async function drive(root: string, id: string, engine: LoopEngine, step: boolean): Promise<void> {
  const job: Job = { kind: 'task', started: Date.now(), lines: [], engine };
  jobs.set(key(root, id), job);
  const mark = (s: string) => (s === 'running' ? '▶' : s === 'passed' ? '✓' : s === 'failed' ? '✗' : '·');
  engine.on('change', (r: Run) => {
    job.lines = r.stages.flatMap((st) => st.steps.filter((s) => s.status !== 'pending').map((s) => `${mark(s.status)} ${st.title} · ${s.title}${s.summary ? ` — ${s.summary}` : ''}`));
    ChatPanel.refresh();
  });
  ChatPanel.refresh();
  try {
    const done = await engine.start(undefined, step);
    const journal = path.join(RUNS_DIR, `${done.id}.md`);
    const head = done.status === 'passed' ? 'Done: every stage passed.' : `The run ${done.status}.`;
    const why = done.diagnosis ? `\n\n**Why it failed** (local diagnoser):\n\n${done.diagnosis}` : '';
    append(root, id, { role: 'agent', text: `${head}${why}\n\n${done.notes ?? ''}`.trim(), at: Date.now(), run: done.id, journal, failed: done.status !== 'passed', steps: job.lines, seconds: Math.round((Date.now() - job.started) / 1000) });
    notices.add({ tool: 'agent', title: done.status === 'passed' ? 'The order is done' : 'The order failed', text: done.spec.title, level: done.status === 'passed' ? 'info' : 'error', root, ref: id });
  } finally {
    jobs.delete(key(root, id));
    ChatPanel.refresh();
  }
}

function task(root: string, id: string, text: string): Promise<void> {
  const card = readCard(root);
  const title = text.split(/[.\n]/)[0].slice(0, 60);
  const spec: Spec = { id: `${slug(title)}-${Date.now().toString(36)}`, title, useCase: /^fix\b/i.test(text) ? 'bug' : 'feature', description: text, criteria: criteriaOf(text), context: [], source: { kind: 'local' }, lead: 'local', pieces: [] };
  return drive(root, id, new LoopEngine(newRun(root, { name: card?.name ?? path.basename(root), platform: card?.platform ?? null, dialect: card?.dialect ?? '' }, spec), readConfig(root, card?.platform ?? '', machineConfig())), false);
}

export class ChatPanel {
  private static current: ChatPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private root = '';
  private sessionId: string | undefined;
  private disposed = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projects: () => LoopProject[],
  ) {
    this.panel = vscode.window.createWebviewPanel('nuclear.chat', 'Nuclear agent', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icons', 'nuc-file.svg');
    this.panel.webview.html = html(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.disposed = true;
      ChatPanel.current = undefined;
      notices.watch('agent', false);
    });
    this.panel.onDidChangeViewState((e) => notices.watch('agent', e.webviewPanel.visible && e.webviewPanel.active));
    this.panel.webview.onDidReceiveMessage((m: Message) => void this.receive(m).catch((e) => void vscode.window.showErrorMessage(`Nuclear agent: ${e instanceof Error ? e.message : e}`)));
  }

  /** The chat page, created or revealed, on the active project (or the first one), on a session when given. */
  static show(context: vscode.ExtensionContext, projects: () => LoopProject[], active?: string, session?: string): void {
    const p = ChatPanel.current ?? (ChatPanel.current = new ChatPanel(context, projects));
    if (active && projects().some((x) => x.root === active)) p.root = active;
    if (session) p.sessionId = session;
    p.panel.reveal(vscode.ViewColumn.Active);
    notices.watch('agent', true);
    p.state();
  }

  static close(): void {
    ChatPanel.current?.panel.dispose();
  }

  /** Redraws the open page (a job changed or ended); nothing when it is closed. */
  static refresh(): void {
    ChatPanel.current?.state();
  }

  private post(m: unknown): void {
    if (!this.disposed) void this.panel.webview.postMessage(m);
  }

  private state(): void {
    const projects = this.projects();
    if (!projects.some((p) => p.root === this.root)) {
      this.root = projects[0]?.root ?? '';
      this.sessionId = undefined;
    }
    const card = this.root ? readCard(this.root) : undefined;
    const sessions = this.root ? listSessions(this.root) : [];
    let session = this.sessionId ? sessions.find((s) => s.id === this.sessionId) ?? null : null;
    const job = this.sessionId ? jobs.get(key(this.root, this.sessionId)) : undefined;
    // a question left without an answer and nothing working on it: the editor was closed while it thought
    const last = session?.messages.at(-1);
    if (session && last?.role === 'you' && !job && Date.now() - last.at > 5000) {
      append(this.root, session.id, { role: 'agent', text: 'interrupted: the editor was closed while the agent was thinking', at: Date.now(), failed: true });
      session = loadSession(this.root, session.id) ?? session;
    }
    const map = this.root ? mapOf(this.root) : '';
    const s = aiSettings();
    this.post({
      type: 'state',
      projects: projects.map((p) => ({ root: p.root, name: p.name })),
      root: this.root,
      platform: card?.platform ?? '',
      sessions: sessions.map((x) => ({ id: x.id, title: x.title, at: x.messages.at(-1)?.at ?? x.created, busy: jobs.has(key(this.root, x.id)) })),
      session,
      job: job ? { kind: job.kind, started: job.started, lines: job.lines } : null,
      templates: this.root ? templatesOf(map, card?.platform ?? '') : [],
      asked: askedOf(sessions),
      hasMap: !!map,
      context: { window: s.contextTokens, model: s.assistantModel, map: tokensOf(Math.min(map.length, MAP_LIMIT)), history: tokensOf(historyOf(session?.messages ?? []).length) },
    });
  }

  private async receive(m: Message): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.state();
      case 'project':
        this.root = m.root;
        this.sessionId = undefined;
        return this.state();
      case 'new':
        this.sessionId = undefined;
        return this.state();
      case 'open':
        this.sessionId = m.id;
        return this.state();
      case 'delete': {
        const ok = await vscode.window.showWarningMessage('Delete this session?', { modal: true }, 'Delete');
        if (ok !== 'Delete') return;
        fs.rmSync(path.join(this.root, CHAT_DIR, `${m.id}.json`), { force: true });
        if (this.sessionId === m.id) this.sessionId = undefined;
        return this.state();
      }
      case 'stop': {
        const job = this.sessionId ? jobs.get(key(this.root, this.sessionId)) : undefined;
        job?.engine?.stop();
        job?.abort?.abort();
        return;
      }
      case 'file':
        await vscode.window.showTextDocument(vscode.Uri.file(path.isAbsolute(m.file) ? m.file : path.join(this.root, m.file)), { preview: false });
        return;
      case 'send':
        return this.send(m.text.trim());
      case 'ask': {
        // retry a question that failed: the failed answer is dropped and the question asked again
        const s = this.sessionId ? loadSession(this.root, this.sessionId) : undefined;
        if (!s || jobs.has(key(this.root, s.id))) return;
        const question = s.messages.slice(0, m.index).reverse().find((x) => x.role === 'you');
        if (!question) return;
        s.messages.splice(m.index, 1);
        saveSession(this.root, s);
        void (question.text.startsWith('/task') ? task(this.root, s.id, question.text.replace(/^\/task\s*/, '')) : ask(this.root, s.id, question.text));
        return;
      }
      case 'retry': {
        const run = listRuns(this.root).find((r) => r.id === m.run);
        if (!run || !this.sessionId || jobs.has(key(this.root, this.sessionId))) return;
        append(this.root, this.sessionId, { role: 'you', text: `↻ Retry the run ${run.id} from the step that failed`, at: Date.now() });
        void drive(this.root, this.sessionId, new LoopEngine(run, readConfig(this.root, run.platform, machineConfig())), true);
        return;
      }
    }
  }

  private send(text: string): void {
    if (!text || !this.root) return;
    if (this.sessionId && jobs.has(key(this.root, this.sessionId))) return;
    const id = this.sessionId ?? `${new Date().toISOString().slice(0, 10)}-${slug(text).slice(0, 24)}-${Date.now().toString(36)}`;
    this.sessionId = id;
    append(this.root, id, { role: 'you', text, at: Date.now() }, text.replace(/^\/task\s+/, '').slice(0, 60));
    if (text.startsWith('/task')) {
      const order = text.replace(/^\/task\s*/, '');
      if (!order) return append(this.root, id, { role: 'agent', text: 'Write what to do after /task, and its acceptance criteria.', at: Date.now(), failed: true });
      void task(this.root, id, order);
    } else void ask(this.root, id, text);
  }
}

export function html(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2);
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  .app { display: grid; grid-template-columns: 240px 1fr; height: 100vh; }
  aside { border-right: 1px solid var(--vscode-panel-border); padding: 12px; overflow: auto; display: flex; flex-direction: column; gap: 8px; }
  select, button, textarea { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; }
  button { cursor: pointer; padding: 4px 10px; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; }
  .sessions { display: flex; flex-direction: column; gap: 2px; }
  .session { display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
  .session:hover, .session.on { background: var(--vscode-list-hoverBackground); }
  .session span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .session .x { opacity: .5; border: none; background: none; padding: 0 4px; }
  .spin { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--vscode-progressBar-background, #0a84ff); animation: pulse 1s infinite alternate; }
  @keyframes pulse { from { opacity: .3; } to { opacity: 1; } }
  main { display: grid; grid-template-rows: 1fr auto; min-height: 0; }
  .log { overflow: auto; padding: 16px 24px; display: flex; flex-direction: column; gap: 14px; }
  .msg { max-width: 860px; line-height: 1.5; }
  .msg .who { font-size: 11px; opacity: .6; margin-bottom: 2px; text-transform: uppercase; letter-spacing: .04em; }
  .msg.you .body { background: var(--vscode-input-background); padding: 8px 12px; border-radius: 8px; white-space: pre-wrap; }
  .msg.failed .body > p:first-child { color: var(--vscode-errorForeground); }
  /* what the agent did: grey and folded, like a model's thoughts */
  details.think { color: var(--vscode-descriptionForeground); opacity: .75; font-size: 12px; margin: 2px 0 6px; }
  details.think summary { cursor: pointer; list-style: none; user-select: none; }
  details.think summary::before { content: '▸ '; } details.think[open] summary::before { content: '▾ '; }
  details.think ol { margin: 4px 0 0; padding-left: 20px; border-left: 2px solid var(--vscode-panel-border); font-family: var(--vscode-editor-font-family); white-space: pre-wrap; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 8px 10px; border-radius: 4px; overflow: auto; }
  code { font-family: var(--vscode-editor-font-family); }
  .templates { display: flex; flex-wrap: wrap; gap: 6px; }
  .templates button { border-radius: 12px; font-size: 12px; }
  .empty { opacity: .7; max-width: 640px; }
  form { border-top: 1px solid var(--vscode-panel-border); padding: 10px 24px; display: flex; flex-direction: column; gap: 8px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 64px; resize: vertical; padding: 8px; }
  .row { display: flex; gap: 8px; align-items: center; } .row .hint { flex: 1; opacity: .6; font-size: 12px; }
  .meter { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: .8; }
  .meter .bar { width: 120px; height: 6px; border-radius: 3px; background: var(--vscode-panel-border); overflow: hidden; }
  .meter .bar i { display: block; height: 100%; background: var(--vscode-testing-iconPassed, #16a34a); }
  .meter.high .bar i { background: var(--vscode-editorWarning-foreground, #d97706); } .meter.full .bar i { background: var(--vscode-errorForeground, #b91c1c); }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
</style></head><body><div class="app">
<aside>
  <select id="project"></select>
  <button class="primary" data-act="new">+ New session</button>
  <div class="sessions" id="sessions"></div>
</aside>
<main>
  <div class="log" id="log"></div>
  <form id="form">
    <div class="templates" id="templates"></div>
    <textarea id="input" placeholder="Ask about the project, or give an order: /task Add …   (Enter sends, Shift+Enter is a new line, ↑ the questions before)"></textarea>
    <div class="row"><span class="meter" id="meter"></span><span class="hint" id="hint"></span><button type="button" data-act="stop" id="stop">■ Stop</button><button class="primary" type="submit" id="send">Send</button></div>
  </form>
</main></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const $ = (s) => document.querySelector(s);
let S = { projects: [], sessions: [], session: null, templates: [], asked: [], job: null, context: { window: 8192, map: 0, history: 0 } };
let back = -1; // where ↑ is in the history of questions (-1: the input as typed)
let draft = '';
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const k = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
// markdown enough for the answers: code blocks, inline code, bold, headings, lists, paragraphs
function md(text) {
  const out = [];
  const parts = String(text).split(/\`\`\`[a-z]*\\n?/);
  parts.forEach((p, i) => {
    if (i % 2) { out.push('<pre><code>' + esc(p.replace(/\\n$/, '')) + '</code></pre>'); return; }
    for (const raw of p.split(/\\n{2,}/)) {
      const block = raw.trim();
      if (!block) continue;
      let h = esc(block).replace(/\`([^\`]+)\`/g, '<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g, '<b>$1</b>');
      if (/^#{1,4} /.test(h)) { out.push('<p><b>' + h.replace(/^#+ /, '') + '</b></p>'); continue; }
      if (/^\\s*([-*]|\\d+\\.) /m.test(h)) { out.push('<ul>' + h.split('\\n').map((l) => '<li>' + l.replace(/^\\s*([-*]|\\d+\\.) /, '') + '</li>').join('') + '</ul>'); continue; }
      out.push('<p>' + h.replace(/\\n/g, '<br>') + '</p>');
    }
  });
  return out.join('');
}
function think(steps, label, open) {
  if (!steps || !steps.length) return '';
  return '<details class="think"' + (open ? ' open' : '') + '><summary>' + esc(label) + '</summary><ol>' + steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol></details>';
}
function message(m, i) {
  if (m.role === 'you') return '<div class="msg you"><div class="who">You</div><div class="body">' + esc(m.text) + '</div></div>';
  const label = (m.failed ? 'What it tried' : 'What it did') + (m.seconds !== undefined ? ' · ' + m.seconds + ' s' : '') + (m.tokens ? ' · read ≈' + k(m.tokens) + ' tokens' : '');
  const links = [];
  if (m.journal) links.push('<a data-file="' + esc(m.journal) + '">Open the journal of the run</a>');
  if (m.failed && m.run) links.push('<a data-retry="' + esc(m.run) + '">↻ Retry from the step that failed</a>');
  else if (m.failed) links.push('<a data-ask="' + i + '">↻ Retry</a>');
  return '<div class="msg agent' + (m.failed ? ' failed' : '') + '"><div class="who">Local agent</div>' + think(m.steps, label, false) + '<div class="body">' + md(m.text) + (links.length ? '<p>' + links.join(' · ') + '</p>' : '') + '</div></div>';
}
function meter() {
  const c = S.context;
  const estimate = c.map + c.history + 1500; // + the guide and what the graph gives (about 1.5k tokens)
  const last = (S.session ? S.session.messages : []).filter((m) => m.tokens).pop();
  const now = last ? last.tokens : estimate;
  const pct = Math.min(100, Math.round(now / c.window * 100));
  $('#meter').className = 'meter' + (pct >= 95 ? ' full' : pct >= 75 ? ' high' : '');
  $('#meter').title = 'The local model (' + c.model + ') reads at most ' + c.window + ' tokens: the project map (≈' + k(c.map) + '), the last messages of the session (≈' + k(c.history) + '), the guide and what the Smart Graph finds. '
    + (last ? 'The last answer read ≈' + k(last.tokens) + '.' : 'Estimated before the first answer.') + ' Beyond the window the oldest text is left out: start a new session for a new subject.';
  $('#meter').innerHTML = 'Context <span class="bar"><i style="width:' + pct + '%"></i></span> ≈' + k(now) + ' / ' + k(c.window) + (pct >= 75 ? ' · start a new session soon' : '');
}
function draw() {
  $('#project').innerHTML = S.projects.map((p) => '<option value="' + esc(p.root) + '"' + (p.root === S.root ? ' selected' : '') + '>' + esc(p.name) + '</option>').join('') || '<option>No Nuclear project open</option>';
  $('#sessions').innerHTML = S.sessions.map((s) => '<div class="session' + (S.session && S.session.id === s.id ? ' on' : '') + '" data-open="' + esc(s.id) + '">' + (s.busy ? '<i class="spin" title="thinking"></i>' : '') + '<span title="' + esc(s.title) + '">' + esc(s.title) + '</span><button class="x" data-del="' + esc(s.id) + '" title="Delete">✕</button></div>').join('') || '<div class="empty">No sessions yet.</div>';
  const msgs = S.session ? S.session.messages : [];
  const working = S.job ? '<div class="msg agent"><div class="who">Local agent · ' + (S.job.kind === 'task' ? 'working on the order' : 'thinking') + ' <i class="spin"></i> <span id="elapsed"></span></div>' + think(S.job.lines, S.job.kind === 'task' ? 'Steps of the run' : 'What it is doing', true) + '</div>' : '';
  $('#log').innerHTML = (msgs.length ? msgs.map(message).join('')
    : '<div class="empty"><p><b>The local agent of this project.</b> Ask anything about the project; it answers from the project\\'s map and the Nuclear Smart Graph, on your machine.</p><p>Give an order with <code>/task</code>: the local agents plan it, write the tests first, then the code, run the tests and the security review, and document what they did.</p><p>You can leave this page: it keeps thinking and a notification tells you when it answers.</p>' + (S.hasMap ? '' : '<p>This project has no map yet: run <code>nuclear check .</code> once so the agent knows its declarations.</p>') + '</div>') + working;
  $('#log').scrollTop = $('#log').scrollHeight;
  $('#templates').innerHTML = S.templates.map((t, i) => '<button type="button" data-tpl="' + i + '" title="' + esc(t.text) + '">' + esc(t.label) + '</button>').join('');
  $('#send').disabled = !!S.job || !S.root;
  $('#stop').style.display = S.job ? '' : 'none';
  $('#hint').textContent = S.root ? (S.platform ? S.platform + ' · ' : '') + 'local agents only' : '';
  meter();
  tick();
}
function tick() { const e = $('#elapsed'); if (e && S.job) e.textContent = Math.round((Date.now() - S.job.started) / 1000) + ' s'; }
setInterval(tick, 1000);
function send() { const t = $('#input').value.trim(); if (!t || S.job) return; vscode.postMessage({ type: 'send', text: t }); $('#input').value = ''; back = -1; }
$('#form').addEventListener('submit', (e) => { e.preventDefault(); send(); });
$('#input').addEventListener('keydown', (e) => {
  const i = $('#input');
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); return send(); }
  // ↑ / ↓ go through the questions asked before, when the caret is on the first / last line (like a terminal)
  const firstLine = !i.value.slice(0, i.selectionStart).includes('\\n');
  const lastLine = !i.value.slice(i.selectionEnd).includes('\\n');
  if (e.key === 'ArrowUp' && firstLine && back < S.asked.length - 1) {
    e.preventDefault();
    if (back === -1) draft = i.value;
    back++;
    i.value = S.asked[back];
    i.setSelectionRange(0, 0);
  } else if (e.key === 'ArrowDown' && lastLine && back >= 0) {
    e.preventDefault();
    back--;
    i.value = back === -1 ? draft : S.asked[back];
    i.setSelectionRange(i.value.length, i.value.length);
  }
});
$('#project').addEventListener('change', (e) => vscode.postMessage({ type: 'project', root: e.target.value }));
document.addEventListener('click', (e) => {
  const d = e.target.closest('[data-act],[data-open],[data-del],[data-tpl],[data-file],[data-retry],[data-ask]');
  if (!d) return;
  if (d.dataset.del) { e.stopPropagation(); return vscode.postMessage({ type: 'delete', id: d.dataset.del }); }
  if (d.dataset.open) return vscode.postMessage({ type: 'open', id: d.dataset.open });
  if (d.dataset.file) return vscode.postMessage({ type: 'file', file: d.dataset.file });
  if (d.dataset.retry) return S.job ? undefined : vscode.postMessage({ type: 'retry', run: d.dataset.retry });
  if (d.dataset.ask) return S.job ? undefined : vscode.postMessage({ type: 'ask', index: +d.dataset.ask });
  if (d.dataset.tpl) { const t = S.templates[+d.dataset.tpl].text; const i = $('#input'); i.value = t; i.focus(); const at = t.indexOf('…'); if (at >= 0) i.setSelectionRange(at, at + 1); return; }
  if (d.dataset.act) vscode.postMessage({ type: d.dataset.act });
});
window.addEventListener('message', (e) => { if (e.data.type === 'state') { S = e.data; draw(); } });
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
