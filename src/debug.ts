// Debugging `.nuc` code of a Dragonfly project on top of the Dart extension's `dart` sessions.
//
// `dragonfly build` writes `build/app/.dart_tool/nuclear_lines.json`: for each generated `.dart`, its `.nuc` and
// the pairs (dart line, nuc line). With it:
// - a breakpoint in a `.nuc` gets a mirror breakpoint in the generated `.dart` (the Dart VM only knows `.dart`);
// - when the app pauses, the `.nuc` line of the paused frame is shown and highlighted;
// - a Dart error (pause on exception or an error printed by Flutter) is shown at its `.nuc` line (Problems
//   panel) with a panel beside that explains it, with the Nuclear call stack and the original Dart error.

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isDeviceGroup } from './device';

export interface Project {
  root: string;
  app: string;
  dragonfly: string;
  env: Record<string, string>;
}

interface Entry {
  source: string;
  lines: [number, number][];
}

interface Place {
  path: string;
  line: number; // from 1
}

// ------------------------------------------------------------------ line map

// written by every `nuclear build` (any dialect); a mobile app's `dragonfly build` writes the Dart one
const MAP_FILES = ['.nuclear/lines.json', '.dart_tool/nuclear_lines.json'];

let cache: { file: string; mtime: number; files: Record<string, Entry>; bySource: Map<string, string> } | undefined;

function lineMap(p: Project): typeof cache {
  const file = MAP_FILES.map((f) => path.join(p.app, f)).find((f) => fs.existsSync(f));
  if (!file) return undefined;
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
  if (cache?.file !== file || cache.mtime !== mtime) {
    try {
      const files: Record<string, Entry> = JSON.parse(fs.readFileSync(file, 'utf8')).files ?? {};
      const bySource = new Map(Object.entries(files).map(([out, e]) => [e.source, out]));
      cache = { file, mtime, files, bySource };
    } catch {
      return undefined;
    }
  }
  return cache;
}

const rel = (from: string, to: string) => path.relative(from, to).split(path.sep).join('/');

/** The `.dart` line of a `.nuc` line: its first statement there, else the next one below. */
export function toDart(p: Project, nuc: string, line: number): Place | undefined {
  const m = lineMap(p);
  const out = m?.bySource.get(rel(p.root, nuc));
  if (!m || !out) return undefined;
  const pairs = m.files[out].lines;
  const hit = pairs.find(([, n]) => n === line) ?? pairs.filter(([, n]) => n > line).sort((a, b) => a[1] - b[1])[0];
  return hit && { path: path.join(p.app, out), line: hit[0] };
}

/** The `.nuc` line of a `.dart` line: the closest mapped line at or above it. */
export function toNuc(p: Project, dart: string, line: number): Place | undefined {
  const m = lineMap(p);
  const e = m?.files[rel(p.app, dart)];
  if (!e) return undefined;
  let hit: [number, number] | undefined;
  for (const pair of e.lines) {
    if (pair[0] > line) break;
    hit = pair;
  }
  return hit && { path: path.join(p.root, e.source), line: hit[1] };
}

/** The debug types of the dialects' launches (`build/<name>.code-workspace`, written by the dragonfly CLI). */
const DEBUG_TYPES = ['dart', 'node', 'pwa-node', 'chrome', 'pwa-chrome', 'msedge', 'pwa-msedge', 'debugpy', 'python'];

// ------------------------------------------------------------------ breakpoints

const MIRRORS_KEY = 'nuclear.debug.mirrors';
const mirrors = new Map<string, vscode.SourceBreakpoint>(); // .nuc breakpoint id → its .dart mirror

const isNuc = (b: vscode.Breakpoint): b is vscode.SourceBreakpoint =>
  b instanceof vscode.SourceBreakpoint && b.location.uri.fsPath.endsWith('.nuc');

function mirrorOf(p: Project, b: vscode.SourceBreakpoint): vscode.SourceBreakpoint | undefined {
  const t = toDart(p, b.location.uri.fsPath, b.location.range.start.line + 1);
  if (!t) return undefined;
  const at = new vscode.Location(vscode.Uri.file(t.path), new vscode.Position(t.line - 1, 0));
  return new vscode.SourceBreakpoint(at, b.enabled, b.condition, b.hitCondition, b.logMessage);
}

const same = (a: vscode.SourceBreakpoint, b: vscode.SourceBreakpoint) =>
  a.location.uri.fsPath === b.location.uri.fsPath &&
  a.location.range.start.line === b.location.range.start.line &&
  a.enabled === b.enabled &&
  a.condition === b.condition &&
  a.hitCondition === b.hitCondition &&
  a.logMessage === b.logMessage;

/** Brings the mirrors in line with the `.nuc` breakpoints and the current line maps (each breakpoint with the project
 * of its own file). */
function syncBreakpoints(context: vscode.ExtensionContext, find: (dir?: string) => Project | undefined): void {
  const all = vscode.debug.breakpoints;
  const present = new Set(all.map((b) => b.id));
  const nucs = all.filter(isNuc);
  const live = new Set(nucs.map((b) => b.id));
  const remove: vscode.Breakpoint[] = [];
  const add: vscode.SourceBreakpoint[] = [];
  for (const [id, m] of mirrors) {
    if (!live.has(id)) {
      remove.push(m);
      mirrors.delete(id);
    }
  }
  for (const b of nucs) {
    const p = find(path.dirname(b.location.uri.fsPath));
    const want = p && mirrorOf(p, b);
    const have = mirrors.get(b.id);
    if (have && want && present.has(have.id) && same(have, want)) continue;
    if (have) remove.push(have);
    mirrors.delete(b.id);
    if (want) {
      add.push(want);
      mirrors.set(b.id, want);
    }
  }
  if (remove.length) vscode.debug.removeBreakpoints(remove);
  if (add.length) vscode.debug.addBreakpoints(add);
  const saved = [...mirrors.values()].map((m) => [m.location.uri.fsPath, m.location.range.start.line]);
  void context.workspaceState.update(MIRRORS_KEY, saved);
}

/** VS Code restores the mirrors of the last window as ordinary breakpoints: they are removed and made again. */
function dropOldMirrors(context: vscode.ExtensionContext): void {
  const saved = new Set(context.workspaceState.get<[string, number][]>(MIRRORS_KEY, []).map(([f, l]) => `${f}:${l}`));
  const old = vscode.debug.breakpoints.filter(
    (b) => b instanceof vscode.SourceBreakpoint && saved.has(`${b.location.uri.fsPath}:${b.location.range.start.line}`),
  );
  if (old.length) vscode.debug.removeBreakpoints(old);
}

// ------------------------------------------------------------------ paused frame

const current = vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor('editor.stackFrameHighlightBackground'),
  overviewRulerColor: new vscode.ThemeColor('debugIcon.breakpointCurrentStackframeForeground'),
  overviewRulerLane: vscode.OverviewRulerLane.Full,
});

interface Frame {
  id: number;
  name: string;
  line: number;
  source?: { path?: string };
}

async function frames(session: vscode.DebugSession, threadId: number): Promise<Frame[]> {
  try {
    const r = await session.customRequest('stackTrace', { threadId, startFrame: 0, levels: 40 });
    return r?.stackFrames ?? [];
  } catch {
    return [];
  }
}

/** The frames that come from `.nuc` code, as `.nuc` places. */
function nucFrames(p: Project, list: { name: string; file: string; line: number }[]): (Place & { name: string })[] {
  return list.flatMap((f) => {
    const n = toNuc(p, f.file, f.line);
    return n ? [{ ...n, name: f.name }] : [];
  });
}

async function showPlace(place: Place, column: vscode.ViewColumn, highlight: boolean, reuse = true): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(place.path);
  // the editor that already shows the file, so following a pause does not open new columns
  if (reuse) column = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === place.path)?.viewColumn ?? column;
  const editor = await vscode.window.showTextDocument(doc, { viewColumn: column, preserveFocus: true, preview: true });
  const range = doc.lineAt(Math.min(place.line, doc.lineCount) - 1).range;
  editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  if (highlight) editor.setDecorations(current, [range]);
}

/** The editor that shows `file`, waiting a moment for VS Code to open the paused `.dart`. */
function shownEditor(file: string, ms = 1500): Promise<vscode.TextEditor | undefined> {
  const find = () => vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === file);
  const now = find();
  if (now) return Promise.resolve(now);
  return new Promise((done) => {
    const timer = setTimeout(() => {
      sub.dispose();
      done(undefined);
    }, ms);
    const sub = vscode.window.onDidChangeVisibleTextEditors(() => {
      const e = find();
      if (!e) return;
      clearTimeout(timer);
      sub.dispose();
      done(e);
    });
  });
}

/** A pause laid out as `.nuc | .dart | device`: the `.nuc` goes to the group left of the paused `.dart`. A missing
 * group is made by splitting only the `.dart` group, so the other groups (the device) keep their width. */
async function showPaused(place: Place, dart: string | undefined): Promise<void> {
  const editor = dart ? await shownEditor(dart) : undefined;
  const col = editor?.viewColumn;
  if (!editor || !col) return showPlace(place, vscode.ViewColumn.Beside, true);
  const left = vscode.window.tabGroups.all.find((g) => g.viewColumn === col - 1);
  if (left && !isDeviceGroup(left)) return showPlace(place, left.viewColumn, true, false);
  await vscode.window.showTextDocument(editor.document, { viewColumn: col, preserveFocus: false });
  await vscode.commands.executeCommand('workbench.action.newGroupLeft');
  await showPlace(place, vscode.ViewColumn.Active, true, false);
  const moved = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === dart);
  if (moved) await vscode.window.showTextDocument(moved.document, { viewColumn: moved.viewColumn, preserveFocus: false });
}

function clearCurrent(): void {
  for (const e of vscode.window.visibleTextEditors) {
    e.setDecorations(current, []);
    e.setDecorations(values, []);
  }
}

// ------------------------------------------------------------------ values in the .nuc

const values = vscode.window.createTextEditorDecorationType({
  after: { color: new vscode.ThemeColor('editorInlayHint.foreground'), fontStyle: 'italic', margin: '0 0 0 2em' },
});

interface Variable {
  name: string;
  value: string;
}

async function locals(session: vscode.DebugSession, frameId: number): Promise<Variable[]> {
  try {
    const s = await session.customRequest('scopes', { frameId });
    const ref = s?.scopes?.[0]?.variablesReference;
    if (!ref) return [];
    return (await session.customRequest('variables', { variablesReference: ref }))?.variables ?? [];
  } catch {
    return [];
  }
}

const NAME = /^[A-Za-z_]\w*$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Each local's value at the end of the last line, from the paused member's header to the pause, that names it. */
function showValues(place: Place, vars: Variable[]): void {
  const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === place.path);
  if (!editor) return;
  const doc = editor.document;
  const stop = Math.min(place.line, doc.lineCount) - 1;
  const indent = (t: string) => t.length - t.trimStart().length;
  // shortcut: the member's header is the first line above with less indentation than a body (2 at top level, 4
  // in a module), so a pause inside a nested block starts there; a member range from the LSP would be exact
  const level = indent(doc.lineAt(stop).text) >= 4 ? 4 : 2;
  let from = stop;
  while (from > 0) {
    const t = doc.lineAt(from - 1).text;
    from--;
    if (t.trim() && indent(t) < level) break;
  }
  const left = vars.filter((v) => NAME.test(v.name) && v.name !== 'this');
  const byLine = new Map<number, string[]>();
  for (let l = stop; l >= from && left.length; l--) {
    const code = doc.lineAt(l).text.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*/, '');
    for (let i = left.length - 1; i >= 0; i--) {
      if (!new RegExp(`\\b${escapeRe(left[i].name)}\\b`).test(code)) continue;
      const v = left[i].value.length > 40 ? left[i].value.slice(0, 39) + '…' : left[i].value;
      byLine.set(l, [`${left[i].name} = ${v}`, ...(byLine.get(l) ?? [])]);
      left.splice(i, 1);
    }
  }
  editor.setDecorations(
    values,
    [...byLine].map(([l, parts]) => ({
      range: new vscode.Range(doc.lineAt(l).range.end, doc.lineAt(l).range.end),
      renderOptions: { after: { contentText: parts.join(', ') } },
    })),
  );
}

const KEYWORDS = new Set(
  'use from as if else for in while match return yield break continue try catch finally throw and or not is true false null'.split(' '),
);

/** Hover while paused: the name under the mouse with the chain before it (`user.name`), evaluated as Dart. */
const hover: vscode.EvaluatableExpressionProvider = {
  provideEvaluatableExpression(doc, pos) {
    const r = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
    if (!r || KEYWORDS.has(doc.getText(r))) return undefined;
    const chain = doc.lineAt(pos.line).text.slice(0, r.start.character).match(/(?:[A-Za-z_]\w*\.)+$/)?.[0] ?? '';
    return new vscode.EvaluatableExpression(new vscode.Range(pos.line, r.start.character - chain.length, r.end.line, r.end.character));
  },
};

// ------------------------------------------------------------------ Nuclear steps

// A Nuclear line can be several Dart lines (a widget tree, a propagated Result): a Nuclear step repeats the Dart
// step until the paused frame is on another `.nuc` line or in another call.

type StepKind = 'next' | 'stepIn' | 'stepOut';
const MAX_STEPS = 200;

interface Paused {
  session: vscode.DebugSession;
  threadId: number;
  depth: number;
  top?: Place;
}

let paused: Paused | undefined;
let pending: { kind: StepKind; from: Place; depth: number; steps: number } | undefined;
let nucStepping = false;

function setPaused(next: Paused | undefined, stepping: boolean): void {
  paused = next;
  nucStepping = stepping;
  void vscode.commands.executeCommand('setContext', 'nuclear.pausedInNuc', !!next?.top);
  void vscode.commands.executeCommand('setContext', 'nuclear.nucStepping', stepping);
}

async function nucStep(kind: StepKind): Promise<void> {
  const at = paused;
  if (!at?.top) {
    const builtin = { next: 'stepOver', stepIn: 'stepInto', stepOut: 'stepOut' }[kind];
    await vscode.commands.executeCommand(`workbench.action.debug.${builtin}`);
    return;
  }
  pending = kind === 'stepOut' ? undefined : { kind, from: at.top, depth: at.depth, steps: 0 };
  setPaused(at, true);
  try {
    await at.session.customRequest(kind, { threadId: at.threadId });
  } catch {
    pending = undefined;
  }
}

// ------------------------------------------------------------------ Nuclear call stack

class CallStack implements vscode.TreeDataProvider<vscode.TreeItem> {
  private items: vscode.TreeItem[] = [];
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  set(p: Project | undefined, list: Frame[]): void {
    this.items = p
      ? list.map((f, i) => {
          const item = new vscode.TreeItem(f.name);
          const file = f.source?.path;
          const nuc = file ? toNuc(p, file, f.line) : undefined;
          const place = nuc ?? (file ? { path: file, line: f.line } : undefined);
          if (place) {
            item.description = `${nuc ? rel(p.root, place.path) : path.basename(place.path)}:${place.line}`;
            item.tooltip = file && `${file}:${f.line}`;
            item.command = { command: 'nuclear.debug.openPlace', title: 'Open', arguments: [place] };
          }
          item.iconPath = new vscode.ThemeIcon(i === 0 ? 'debug-stackframe' : nuc ? 'circle-filled' : 'circle-outline');
          return item;
        })
      : [];
    this.changed.fire();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(): vscode.TreeItem[] {
    return this.items;
  }
}

// ------------------------------------------------------------------ runtime errors

interface RuntimeError {
  title: string;
  hint: string;
  text: string;
  frames: (Place & { name: string })[];
}

/** `dragonfly explain --json`: the message, an explanation and the `.nuc` frames of a Dart error text. */
function explainText(p: Project, text: string): Promise<RuntimeError | undefined> {
  return new Promise((done) => {
    const child = execFile(p.dragonfly, ['explain', '--json'], { cwd: p.root, env: { ...process.env, ...p.env, NO_COLOR: '1' } }, (err, stdout) => {
      try {
        const r = JSON.parse(stdout);
        const frames = (r.frames as { source: string; line: number; name: string }[]).map((f) => ({ path: f.source, line: f.line, name: f.name }));
        done(err ? undefined : { title: r.title, hint: r.hint, text, frames });
      } catch {
        done(undefined);
      }
    });
    child.stdin?.end(text);
  });
}

const runtime = vscode.languages.createDiagnosticCollection('dragonfly-runtime');
let panel: vscode.WebviewPanel | undefined;
let panelFrames: Place[] = []; // the frames the panel's links open
let lastShown = { title: '', at: 0 };

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function showError(p: Project, e: RuntimeError): Promise<void> {
  const now = Date.now();
  if (e.title === lastShown.title && now - lastShown.at < 3000) return; // the pause and Flutter's print of it
  lastShown = { title: e.title, at: now };
  const top = e.frames[0];
  if (!top) return;
  const uri = vscode.Uri.file(top.path);
  const d = new vscode.Diagnostic(new vscode.Range(top.line - 1, 0, top.line - 1, 1000), `Runtime error: ${e.title}`, vscode.DiagnosticSeverity.Error);
  d.source = 'dragonfly';
  runtime.set(uri, [d]);
  await showPlace(top, vscode.ViewColumn.One, false);

  let excerpt = '';
  try {
    const lines = fs.readFileSync(top.path, 'utf8').split('\n');
    const from = Math.max(0, top.line - 3);
    excerpt = lines
      .slice(from, top.line + 2)
      .map((l, i) => {
        const n = from + i + 1;
        return `<span class="${n === top.line ? 'hit' : ''}">${String(n).padStart(4)}  ${escape(l)}</span>`;
      })
      .join('\n');
  } catch {
    // the .nuc is gone: the panel shows the rest
  }
  const stack = e.frames
    .map((f, i) => `<li><a href="#" data-i="${i}">${escape(rel(p.root, f.path))}:${f.line}</a> <span class="dim">${escape(f.name)}</span></li>`)
    .join('');
  panel ??= (() => {
    const created = vscode.window.createWebviewPanel('nuclearRuntimeError', 'Nuclear: runtime error', {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: true,
    }, { enableScripts: true });
    created.onDidDispose(() => (panel = undefined));
    created.webview.onDidReceiveMessage((m: { i: number }) => {
      const f = panelFrames[m.i];
      if (f) void showPlace(f, vscode.ViewColumn.One, false);
    });
    return created;
  })();
  panelFrames = e.frames;
  const nonce = Math.random().toString(36).slice(2);
  panel.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 0 16px; }
h2 { color: var(--vscode-errorForeground); font-size: 1.1em; }
pre { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 8px; overflow-x: auto; }
.hit { background: var(--vscode-editor-stackFrameHighlightBackground); display: inline-block; width: 100%; }
.dim { opacity: .7; } a { color: var(--vscode-textLink-foreground); }
</style></head><body>
<h2>${escape(e.title)}</h2>
<p>${escape(e.hint)}</p>
<h3>Where in Nuclear</h3>
<pre>${excerpt}</pre>
<h3>Nuclear call stack</h3><ol>${stack}</ol>
<details><summary>Dart error</summary><pre>${escape(e.text)}</pre></details>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
for (const a of document.querySelectorAll('a[data-i]')) a.addEventListener('click', (ev) => { ev.preventDefault(); vscode.postMessage({ i: Number(a.dataset.i) }); });
</script></body></html>`;
  panel.reveal(vscode.ViewColumn.Beside, true);
}

// Flutter prints a framework error between `══╡ EXCEPTION CAUGHT BY … ╞══` (or `════ Exception caught by … ════`)
// and a line of `═`; an error of async code as `Unhandled Exception: …` followed by its stack.
const ERROR_START = /═+╡? ?EXCEPTION CAUGHT BY|═+ Exception caught by|Unhandled Exception:/i;

class OutputErrors {
  private buffer = '';
  private timer: NodeJS.Timeout | undefined;

  feed(p: Project, text: string): void {
    if (!this.buffer && !ERROR_START.test(text)) return;
    if (!this.buffer) text = text.slice(text.search(ERROR_START));
    this.buffer += text;
    clearTimeout(this.timer);
    // the whole block arrives in a few output events
    this.timer = setTimeout(() => this.flush(p), 400);
  }

  private flush(p: Project): void {
    const text = this.buffer;
    this.buffer = '';
    void explainText(p, text).then((e) => e && showError(p, e));
  }
}

// ------------------------------------------------------------------ activation

export function activateDebug(context: vscode.ExtensionContext, find: (dir?: string) => Project | undefined): { built(): void } {
  const options = () => vscode.workspace.getConfiguration('nuclear.debug');
  const callStack = new CallStack();
  const sync = () => syncBreakpoints(context, find);
  dropOldMirrors(context);
  sync();
  const watcher = vscode.workspace.createFileSystemWatcher('**/{.nuclear/lines.json,.dart_tool/nuclear_lines.json}');
  context.subscriptions.push(
    runtime,
    watcher,
    watcher.onDidChange(sync),
    watcher.onDidCreate(sync),
    vscode.debug.onDidChangeBreakpoints((e) => {
      if ([...e.added, ...e.removed, ...e.changed].some(isNuc)) sync();
    }),
    vscode.debug.onDidTerminateDebugSession(() => {
      clearCurrent();
      pending = undefined;
      setPaused(undefined, false);
      callStack.set(undefined, []);
    }),
    vscode.window.registerTreeDataProvider('nuclear.callStack', callStack),
    vscode.languages.registerEvaluatableExpressionProvider('nuclear', hover),
    vscode.commands.registerCommand('nuclear.debug.stepOver', () => nucStep('next')),
    vscode.commands.registerCommand('nuclear.debug.stepInto', () => nucStep('stepIn')),
    vscode.commands.registerCommand('nuclear.debug.stepOut', () => nucStep('stepOut')),
    vscode.commands.registerCommand('nuclear.debug.openPlace', (place: Place) => showPlace(place, vscode.ViewColumn.Active, false)),
    vscode.commands.registerCommand('nuclear.debug.otherSide', () => {
      const editor = vscode.window.activeTextEditor;
      const p = editor && find(path.dirname(editor.document.uri.fsPath));
      if (!editor || !p) return;
      const file = editor.document.uri.fsPath;
      const line = editor.selection.active.line + 1;
      const other = file.endsWith('.nuc') ? toDart(p, file, line) : toNuc(p, file, line);
      if (other) void showPlace(other, vscode.ViewColumn.Beside, false);
      else void vscode.window.showInformationMessage('This line has no counterpart in the generated code (run dragonfly build first).');
    }),
    // every debugger a Dragonfly app runs under: dart (mobile), node (nestjs), chrome (react, also the web device),
    // debugpy (fastapi); the paused frame of a generated file is shown at its .nuc line
    ...DEBUG_TYPES.map((type) =>
      vscode.debug.registerDebugAdapterTrackerFactory(type, {
        createDebugAdapterTracker(session) {
          const c = session.configuration;
          const dir = c.cwd ?? c.webRoot ?? session.workspaceFolder?.uri.fsPath;
          const p = dir ? find(dir) : undefined;
          if (!p || !dir || !path.resolve(dir).startsWith(path.resolve(p.app))) return undefined;
          const output = new OutputErrors();
          return {
            onDidSendMessage: (m: { type?: string; event?: string; body?: Record<string, unknown> }) => {
              if (m.type !== 'event' || !m.body) return;
              if (m.event === 'stopped') void stopped(session, p, m.body as { threadId: number; reason?: string; text?: string });
              else if (m.event === 'continued' && !pending) {
                clearCurrent();
                setPaused(undefined, nucStepping);
              }
              // the explanations of run-time errors read Flutter's output
              else if (m.event === 'output' && type === 'dart' && options().get('explainErrors', true)) output.feed(p, String(m.body.output ?? ''));
            },
          };
        },
      }),
    ),
  );

  async function stopped(session: vscode.DebugSession, p: Project, body: { threadId: number; reason?: string; text?: string }) {
    const all = await frames(session, body.threadId);
    const file = all[0]?.source?.path;
    const top = file ? toNuc(p, file, all[0].line) : undefined;
    const step = pending;
    pending = undefined;
    if (step && body.reason === 'step' && top && step.steps < MAX_STEPS) {
      if (top.path === step.from.path && top.line === step.from.line && all.length === step.depth) {
        pending = { ...step, steps: step.steps + 1 };
        try {
          await session.customRequest(step.kind, { threadId: body.threadId });
          return;
        } catch {
          pending = undefined;
        }
      }
    }
    // a .nuc breakpoint (its mirror) steps by Nuclear lines, a breakpoint written in the .dart by Dart lines
    const mirror = [...mirrors.values()].some((m) => m.location.uri.fsPath === file && m.location.range.start.line === all[0].line - 1);
    const stepping = body.reason === 'step' ? nucStepping : body.reason === 'breakpoint' ? mirror : !!top;
    setPaused({ session, threadId: body.threadId, depth: all.length, top }, stepping);
    callStack.set(top ? p : undefined, all);

    const list = all
      .filter((f) => f.source?.path)
      .map((f) => ({ name: f.name, file: f.source!.path!, line: f.line }));
    const nuc = nucFrames(p, list);
    if (!nuc.length) return;
    clearCurrent();
    if (options().get('followInNuclear', true)) {
      await showPaused(nuc[0], file);
      const inline = vscode.workspace.getConfiguration('debug').get('inlineValues');
      if (top && all[0] && inline !== false && inline !== 'off') showValues(top, await locals(session, all[0].id));
    }
    if (body.reason === 'exception' && options().get('explainErrors', true)) {
      const e = await explainText(p, body.text ?? 'Exception');
      // the paused stack is more exact than the one in the text
      if (e) await showError(p, { ...e, frames: nuc });
    }
  }

  return {
    /** After every `dragonfly build`: lines moved, and old run-time errors no longer apply. */
    built() {
      runtime.clear();
      sync();
    },
  };
}
