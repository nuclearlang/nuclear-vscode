// The Nuclear workspace (ADR-0099): one activity bar container where everything of Nuclear meets. A strip of tabs
// (projects on top, tools at the bottom; keyboard first: Ctrl+1..9 and Ctrl+Alt+<letter>) beside a pane that
// depends on the tab: the files of a project (its platform's actions sit in the editor title bar), the endpoints tree of the HTTP tool, the
// open devices. Every tab is a workspace of its own: switching swaps the editor area (the editors of one are
// remembered and closed, those of the other reopened); only the devices stay, like emulators beside the code. A
// welcome page at startup lists the projects and the shortcuts. VS Code's own explorer, search and git are not
// touched: a project opened here is a tab, not a window nor a workspace folder (unless the user adds it).

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { isInstalled } from './card';
import { devices, devicesChanged, PRESETS, revealDevice } from './device';
import { findProjects, HttpModel, NodeAction, Project, readProject } from './http';
import { ComponentPanel } from './httpPanel';

interface Tool {
  id: string;
  label: string;
  /** The two or three letters on the strip. */
  short: string;
  key: string;
  about: string;
  /** What the template page lists as planned; empty for a tool that exists. */
  planned: string[];
}

export const TOOLS: Tool[] = [
  {
    id: 'http',
    label: 'HTTP client',
    short: 'HTTP',
    key: 'Ctrl+Alt+H',
    about: 'Every endpoint of every project as a tree by platform, project and component; a component is a tab, each endpoint a tab inside it; environments (ADR-0098).',
    planned: [],
  },
  {
    id: 'devices',
    label: 'Devices',
    short: 'DEV',
    key: 'Ctrl+Alt+V',
    about: 'The Dragonfly devices: as many as you want at once, like emulators, each with its own size and identity; they stay beside the code in every workspace.',
    planned: [],
  },
  {
    id: 'designer',
    label: 'UI designer',
    short: 'UI',
    key: 'Ctrl+Alt+D',
    about: 'Screens and widgets of a mobile or web project drawn and edited visually, written back as Nuclear.',
    planned: ['a canvas of the active screen built from its `.nuc`', 'drag of widgets from the platform kinds', 'two-way: the code changes, the canvas follows'],
  },
  {
    id: 'docs',
    label: 'AI documenter',
    short: 'DOC',
    key: 'Ctrl+Alt+M',
    about: 'Documentation of the active project generated from its declarations, contracts and doc comments.',
    planned: ['a page per component with its use cases, repositories and screens', 'the API reference from `.nuclear/openapi.json`', 'a model explaining each declaration on demand'],
  },
  {
    id: 'agent',
    label: 'Nuclear agent',
    short: 'AI',
    key: 'Ctrl+Alt+A',
    about: 'A local agent that knows the skill, the specs and the active project, to write and fix Nuclear code.',
    planned: ['chat over the active project with the `nuclear` skill loaded', 'apply a change as a diff of `.nuc` files', 'run `nuclear check` and `dragonfly test` and read the result'],
  },
  {
    id: 'settings',
    label: 'Settings and integrations',
    short: '⚙',
    key: 'Ctrl+Alt+S',
    about: 'Where every integration is configured: AI providers, devices, backends, the language server.',
    planned: ['providers and keys for the agent and the documenter', 'the Dragonfly device and the emulators', 'the extension settings in one form'],
  },
];

/** The actions of a project, by platform: each platform has its own (mobile runs on a device and hot reloads,
 * a backend serves and exposes an API, a web app serves in the browser). */
interface Action {
  id: string;
  label: string;
  key: string;
  title: string;
}
const ACTION_KEYS: Record<string, string> = { run: 'Ctrl+Alt+R', debug: 'Ctrl+Alt+G', reload: 'Ctrl+Alt+L', device: 'Ctrl+Alt+V', build: 'Ctrl+Alt+B', test: 'Ctrl+Alt+T', check: 'Ctrl+Alt+C', api: 'Ctrl+Alt+H' };
const action = (id: string, label: string, title: string): Action => ({ id, label, key: ACTION_KEYS[id], title });
const PLATFORM_ACTIONS: Record<string, Action[]> = {
  mobile: [
    action('run', '▷ Run', 'dragonfly build, then the app on the selected Flutter device (no debugger)'),
    action('debug', '◉ Debug', 'the app with the debugger: breakpoints and steps in the .nuc'),
    action('reload', '↻ Reload', 'hot reload of the running app (saving a .nuc does it too)'),
    action('device', '▭ Device', 'run on a Dragonfly device inside the editor (the newest one, or a new one)'),
    action('build', '⚒ Build', 'dragonfly build: transpile and prepare the Flutter app'),
    action('test', '✓ Test', 'dragonfly test'),
    action('check', '☑ Check', 'dragonfly check: the .nuc files and the architecture rules'),
  ],
  backend: [
    action('run', '▷ Serve', 'dragonfly run: build, then the server (it restarts on every build: saving a .nuc does it)'),
    action('debug', '◉ Debug', "the server under the dialect's debugger (debugpy, node): breakpoints and steps in the .nuc"),
    action('test', '✓ Test', 'dragonfly test'),
    action('build', '⚒ Build', 'dragonfly build: transpile into build/ (and compile a TypeScript server)'),
    action('check', '☑ Check', 'dragonfly check: the .nuc files and the architecture rules'),
    action('api', '⇄ API', 'the routes of this backend in the HTTP tool'),
  ],
  web: [
    action('run', '▷ Serve', 'dragonfly run: build, then the dev server (Vite); saving a .nuc updates the page'),
    action('device', '▭ Device', 'the app in the web device beside the code: desktop, tablet and phone sizes, console, network'),
    action('debug', '◉ Debug', 'the web device with the debugger attached: breakpoints and steps in the .nuc'),
    action('reload', '↻ Reload', 'reload the page of the web device'),
    action('build', '⚒ Build', 'dragonfly build'),
    action('test', '✓ Test', 'dragonfly test: the tests of the app (vitest)'),
    action('check', '☑ Check', 'dragonfly check: the .nuc files and the architecture rules'),
  ],
};
// what an action runs in the project's terminal; `install` first when the generated app has no packages yet
const TERMINAL_COMMANDS: Record<string, Record<string, string>> = {
  mobile: { build: 'dragonfly build', test: 'dragonfly test', check: 'dragonfly check' },
  backend: { run: 'dragonfly run', test: 'dragonfly test', build: 'dragonfly build', check: 'dragonfly check' },
  web: { run: 'dragonfly run', build: 'dragonfly build', test: 'dragonfly test', check: 'dragonfly check' },
};

const SAVED = 'nuclear.workspace.projects';
const ACTIVE = 'nuclear.workspace.active';
const LAST_PROJECT = 'nuclear.workspace.lastProject';
const TABS = 'nuclear.workspace.tabs';
const WELCOME = 'nuclear.workspace.welcome';
const CONTAINER = 'workbench.view.extension.nuclear';
const TOOL_PREFIX = 'tool:';
/** A run/debug/device asked for a project that had to join the workspace folders first (user state: the join
 * restarts the extensions or needs a reload, and an untitled multi-root workspace has no workspace state). */
const PENDING = 'nuclear.workspace.pendingAction';
interface PendingAction {
  root: string;
  id: string;
  at: number;
}
const inFolders = (root: string) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(root)) !== undefined;

/** The dialect badge on a project tab: an icon of the Chernobyl icon theme (Atom Material). */
const DIALECT_ICONS: Record<string, string> = { flutter: 'flutter', react: 'react', fastapi: 'python', nestjs: 'nest', dart: 'dart', python: 'python', typescript: 'typeScript' };

export function activateWorkspace(context: vscode.ExtensionContext, http: HttpModel): Workspace {
  const ws = new Workspace(context, http);
  http.extraRoots = () => ws.saved();
  http.refresh();
  ws.refresh();
  // one command per action, so the editor title bar can show the buttons of the active project's platform
  for (const id of ['run', 'debug', 'reload', 'device', 'build', 'test', 'check', 'api']) {
    context.subscriptions.push(vscode.commands.registerCommand(`nuclear.action.${id}`, () => ws.action(id)));
  }
  context.subscriptions.push(vscode.commands.registerCommand('nuclear.action.serve', () => ws.action('run')));
  const cards = vscode.workspace.createFileSystemWatcher('**/.nuclear/project.json');
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('nuclear.workspace', ws, { webviewOptions: { retainContextWhenHidden: true } }),
    cards,
    cards.onDidCreate(() => ws.refresh()),
    cards.onDidDelete(() => ws.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      ws.refresh();
      // the Dart extension decides at activation whether the workspace has Flutter projects: reload, then continue
      const pending = context.globalState.get<PendingAction>(PENDING);
      if (pending && inFolders(pending.root)) void vscode.commands.executeCommand('workbench.action.reloadWindow');
    }),
    http.onDidChange(() => ws.activeKey() === TOOL_PREFIX + 'http' && ws.refresh()),
    devicesChanged.event(() => ws.activeKey() === TOOL_PREFIX + 'devices' && ws.refresh()),
    vscode.commands.registerCommand('nuclear.workspace.show', () => vscode.commands.executeCommand(CONTAINER)),
    vscode.commands.registerCommand('nuclear.workspace.project', (index?: number) => ws.selectProject(index)),
    vscode.commands.registerCommand('nuclear.workspace.openProject', () => ws.openProject()),
    vscode.commands.registerCommand('nuclear.workspace.tool', (id?: string) => ws.openTool(id)),
    vscode.commands.registerCommand('nuclear.workspace.action', (id?: string) => ws.action(id)),
    vscode.commands.registerCommand('nuclear.workspace.welcome', () => WelcomePanel.show(context, ws)),
    vscode.commands.registerCommand('nuclear.workspace.addToVsCode', () => ws.addToVsCode()),
  );
  const pending = context.globalState.get<PendingAction>(PENDING);
  if (pending && Date.now() - pending.at < 300_000 && inFolders(pending.root)) {
    void context.globalState.update(PENDING, undefined);
    void ws.go(pending.root).then(() => ws.action(pending.id));
    return ws;
  }
  // the welcome page at startup, unless the user turned it off or the window restored editors
  if (vscode.workspace.getConfiguration().get<boolean>(WELCOME, true) && vscode.window.tabGroups.all.every((g) => g.tabs.length === 0)) {
    WelcomePanel.show(context, ws);
  }
  return ws;
}

interface SavedTab {
  path: string;
  column: vscode.ViewColumn;
  active: boolean;
}

class Workspace implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private filesWatcher: vscode.Disposable | undefined;
  private readonly icons: Icons;
  readonly onDidChange = new vscode.EventEmitter<void>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly http: HttpModel,
  ) {
    this.icons = new Icons(context);
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('files.exclude')) {
          this.icons.load();
          this.refresh();
        }
      }),
    );
  }

  // ---------- what is open ----------

  /** The projects of the workspace folders first, then the ones opened here, in the order they were opened. */
  projects(): Project[] {
    const out = findProjects();
    const seen = new Set(out.map((p) => p.root));
    for (const root of this.saved()) {
      if (seen.has(root)) continue;
      const p = projectAt(root);
      if (p) out.push(p);
    }
    return out;
  }

  /** The active tab: a project's root, or `tool:<id>`. */
  activeKey(): string {
    const key = this.context.workspaceState.get<string>(ACTIVE);
    if (key?.startsWith(TOOL_PREFIX)) return TOOLS.some((t) => TOOL_PREFIX + t.id === key) ? key : TOOL_PREFIX + 'http';
    const all = this.projects();
    return all.find((p) => p.root === key)?.root ?? all[0]?.root ?? '';
  }

  /** The active project, or the last one when a tool is active (the one the tools act on). */
  active(): Project | undefined {
    const key = this.activeKey();
    const root = key.startsWith(TOOL_PREFIX) ? this.context.workspaceState.get<string>(LAST_PROJECT) : key;
    const all = this.projects();
    return all.find((p) => p.root === root) ?? all[0];
  }

  saved(): string[] {
    return this.context.globalState.get<string[]>(SAVED, []);
  }

  // ---------- switching ----------

  async go(key: string): Promise<void> {
    const previous = this.activeKey();
    if (previous !== key && !(await this.switchTabs(previous, key))) return;
    await this.context.workspaceState.update(ACTIVE, key);
    if (!key.startsWith(TOOL_PREFIX)) await this.context.workspaceState.update(LAST_PROJECT, key);
    this.refresh();
    await vscode.commands.executeCommand(CONTAINER);
  }

  /** Each tab has its own editors: leaving remembers and closes them, entering reopens its own. The devices stay. */
  private async switchTabs(from: string, to: string): Promise<boolean> {
    const isDevice = (t: vscode.Tab) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('dragonflyDevice');
    const open = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => !isDevice(t));
    const saved = this.context.workspaceState.get<Record<string, SavedTab[]>>(TABS, {});
    if (from) {
      saved[from] = open
        .filter((t) => t.input instanceof vscode.TabInputText)
        .map((t) => ({ path: (t.input as vscode.TabInputText).uri.fsPath, column: t.group.viewColumn, active: t.isActive && t.group.isActive }));
      await this.context.workspaceState.update(TABS, saved);
      if (from === TOOL_PREFIX + 'http') this.http.reopen = ComponentPanel.openKeys();
    }
    // an unsaved editor is never closed (VS Code would ask to save, as if the window closed): it stays until saved
    const closable = open.filter((t) => !t.isDirty);
    if (closable.length) await vscode.window.tabGroups.close(closable, true);
    // the devices belong to the mobile workspaces and the Devices tool: elsewhere they are parked (their apps go on).
    // Always park before reopening: a device panel left over from the previous workspace collapses into the first
    // column and the reopened code would merge into its group; unpark (below) gives it a fresh group beside the code.
    const mobile = to === TOOL_PREFIX + 'devices' || this.projects().find((p) => p.root === to)?.platform === 'mobile';
    await vscode.commands.executeCommand('nuclear.parkDevices');
    const tool = TOOLS.find((t) => TOOL_PREFIX + t.id === to);
    if (tool) {
      if (tool.id === 'http') ComponentPanel.restore(this.context, this.http, this.http.reopen);
      else if (tool.id === 'devices') await vscode.commands.executeCommand('nuclear.unparkDevices');
      else if (tool.planned.length) ToolPanel.show(this.context, tool);
      return true;
    }
    for (const t of (saved[to] ?? []).sort((a, b) => Number(a.active) - Number(b.active))) {
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(t.path), { viewColumn: t.column, preview: false, preserveFocus: !t.active });
      } catch {
        // the file is gone
      }
    }
    if (mobile) await vscode.commands.executeCommand('nuclear.unparkDevices'); // beside the code just reopened
    return true;
  }

  async selectProject(index?: number): Promise<void> {
    const all = this.projects();
    let p = index !== undefined ? all[index - 1] : undefined;
    if (index === undefined) {
      const pick = await vscode.window.showQuickPick(
        all.map((x, i) => ({ label: `${i < 9 ? `Ctrl+${i + 1}  ` : ''}${x.name}`, description: `${x.platform ?? ''} · ${x.dialect}`, detail: x.root, x })),
        { placeHolder: 'Project to show' },
      );
      p = pick?.x;
    }
    if (!p) {
      if (index !== undefined) void vscode.window.showInformationMessage(`No project ${index} in the Nuclear workspace (Ctrl+Alt+O opens one).`);
      return;
    }
    await this.go(p.root);
  }

  async openProject(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Open as a Nuclear project' });
    const root = picked?.[0]?.fsPath;
    if (!root) return;
    if (!projectAt(root)) {
      void vscode.window.showWarningMessage(`${path.basename(root)} is not a Nuclear project (no config.nuc, nuclear.toml or .nuclear/project.json).`);
      return;
    }
    const saved = this.saved();
    if (!saved.includes(root)) await this.context.globalState.update(SAVED, [...saved, root]);
    this.http.refresh();
    await this.go(root);
  }

  async removeProject(root: string): Promise<void> {
    await this.context.globalState.update(SAVED, this.saved().filter((r) => r !== root));
    if (this.activeKey() === root) await this.context.workspaceState.update(ACTIVE, undefined);
    this.http.refresh();
    this.refresh();
  }

  async openTool(id?: string): Promise<void> {
    let tool = TOOLS.find((t) => t.id === id);
    if (!id) {
      const pick = await vscode.window.showQuickPick(TOOLS.map((t) => ({ label: `${t.key}  ${t.label}`, description: t.about, t })), { placeHolder: 'Tool to open' });
      tool = pick?.t;
    }
    if (!tool) return;
    await this.go(TOOL_PREFIX + tool.id);
    if (tool.planned.length) ToolPanel.show(this.context, tool);
  }

  // ---------- the actions of a project ----------

  async action(id?: string): Promise<void> {
    const p = this.active();
    if (!p) {
      void vscode.window.showInformationMessage('No project in the Nuclear workspace (Ctrl+Alt+O opens one).');
      return;
    }
    const actions = PLATFORM_ACTIONS[p.platform ?? ''] ?? [];
    let a = actions.find((x) => x.id === id);
    if (!id) {
      const pick = await vscode.window.showQuickPick(actions.map((x) => ({ label: `${x.key}  ${x.label}`, description: x.title, x })), { placeHolder: `${p.name} (${p.platform})` });
      a = pick?.x;
    }
    if (!a) {
      if (id) void vscode.window.showInformationMessage(`${p.name} is a ${p.platform ?? 'plain'} project: it has no "${id}" action.`);
      return;
    }
    if (p.platform === 'mobile' && ['run', 'debug', 'device'].includes(a.id) && !(await this.inWorkspace(p, a.id))) return;
    if (p.platform === 'mobile' && (a.id === 'run' || a.id === 'debug')) return this.pickDevice(p, a.id);
    if (p.platform === 'web' && a.id === 'device') return vscode.commands.executeCommand('nuclear.webDevice.open', p.root);
    if (p.platform === 'web' && a.id === 'debug') return vscode.commands.executeCommand('nuclear.webDevice.debug', p.root);
    if (p.platform === 'web' && a.id === 'reload') return vscode.commands.executeCommand('nuclear.webDevice.reload', p.root);
    if (a.id === 'debug') return vscode.commands.executeCommand('nuclear.debug', p.root);
    if (a.id === 'reload') return vscode.commands.executeCommand('flutter.hotReload');
    if (a.id === 'device') return this.pickDevice(p, 'device');
    if (a.id === 'api') return this.openTool('http');
    let cmd = TERMINAL_COMMANDS[p.platform ?? '']?.[a.id];
    if (!cmd) return;
    if (p.platform !== 'mobile' && (a.id === 'run' || a.id === 'test') && !isInstalled(p.root)) cmd = `dragonfly install && ${cmd}`;
    const name = `${p.name} · ${a.id}`;
    const terminal = vscode.window.terminals.find((t) => t.name === name) ?? vscode.window.createTerminal({ name, cwd: p.root });
    terminal.show(true);
    terminal.sendText(cmd);
  }

  /** The Dart extension launches Flutter only for a project inside the workspace folders ("Dart-only workspace"):
   * a project opened as a tab joins them first; the window reloads and `activateWorkspace` continues the action. */
  private async inWorkspace(p: Project, id: string): Promise<boolean> {
    if (inFolders(p.root)) return true;
    await this.context.globalState.update(PENDING, { root: p.root, id, at: Date.now() });
    void vscode.window.showInformationMessage(`${p.name} joins the VS Code workspace folders (the Dart extension runs Flutter only there); the window reloads and the ${id} continues.`);
    await this.addToVsCode();
    return false;
  }

  /** ▷ Run, ◉ Debug and ▭ Device of a mobile project: the Dragonfly devices (shown or hidden) to run on, a new
   * one, any other Flutter device (emulators, phones, Chrome, desktop: Flutter's own picker), or the Devices
   * workspace. */
  private async pickDevice(p: Project, mode: 'run' | 'debug' | 'device'): Promise<void> {
    type Item = vscode.QuickPickItem & { id: string };
    const items: Item[] = [
      ...devices().map((d) => ({ label: `$(device-mobile) ${d.title}`, description: d.status === 'idle' ? 'free' : d.status === 'hidden' ? 'running, hidden' : `${d.status} · runs again`, id: d.id })),
      { label: '$(add) New Dragonfly device…', description: 'one more, beside the others', id: 'new' },
      ...(mode === 'device'
        ? [{ label: '$(layout) Devices workspace', description: TOOLS.find((t) => t.id === 'devices')?.key, id: 'tool' }]
        : [{ label: '$(vm) Other Flutter device…', description: 'emulators, phones, Chrome, desktop', id: 'flutter' }]),
    ];
    const verb = mode === 'debug' ? 'Debug' : 'Run';
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `${verb} ${p.name} on` });
    if (!pick) return;
    if (pick.id === 'tool') return this.openTool('devices');
    if (pick.id === 'flutter') {
      await vscode.commands.executeCommand('flutter.selectDevice');
      return vscode.commands.executeCommand(mode === 'debug' ? 'nuclear.debug' : 'nuclear.run', p.root);
    }
    let id: string | undefined = pick.id;
    if (id === 'new') id = (await this.newDevice())?.id;
    if (id) await vscode.commands.executeCommand('nuclear.runOnDevice', id, p.root, mode === 'run');
  }

  /** The mobile project a device runs: the active one, else the only one, else a pick. */
  private async mobileRoot(): Promise<string | undefined> {
    const active = this.active();
    if (active?.platform === 'mobile') return active.root;
    const mobile = this.projects().filter((p) => p.platform === 'mobile');
    if (!mobile.length) {
      void vscode.window.showInformationMessage('No mobile project in the Nuclear workspace: the devices run mobile apps.');
      return undefined;
    }
    if (mobile.length === 1) return mobile[0].root;
    const pick = await vscode.window.showQuickPick(mobile.map((p) => ({ label: p.name, detail: p.root, root: p.root })), { placeHolder: 'Mobile project to run on the device' });
    return pick?.root;
  }

  async addToVsCode(): Promise<void> {
    const p = this.active();
    if (!p) return;
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.some((f) => f.uri.fsPath === p.root)) return;
    vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri: vscode.Uri.file(p.root), name: p.name });
  }

  // ---------- the view ----------

  refresh(): void {
    this.onDidChange.fire();
    const key = this.activeKey();
    const active = key.startsWith(TOOL_PREFIX) ? undefined : this.active();
    // the editor title bar shows the actions of this platform (package.json `editor/title`, `when: nuclear.platform == ...`)
    void vscode.commands.executeCommand('setContext', 'nuclear.platform', active?.platform ?? '');
    if (!this.view) return;
    const webview = this.view.webview;
    this.watchFiles(active?.root);
    const tool = TOOLS.find((t) => TOOL_PREFIX + t.id === key);
    const envs = this.http.environments();
    const pane = !tool
      ? { kind: 'files', project: active && { root: active.root, name: active.name, platform: active.platform, dialect: active.dialect } }
      : tool.id === 'http'
        ? { kind: 'tree', nodes: this.http.tree(), environment: envs.active }
        : tool.id === 'devices'
          ? { kind: 'devices', devices: devices(), project: this.active()?.name }
          : { kind: 'template', tool: { id: tool.id, label: tool.label, about: tool.about, key: tool.key } };
    void webview.postMessage({
      type: 'state',
      projects: this.projects().map((p) => ({
        root: p.root,
        name: p.name,
        platform: p.platform,
        dialect: p.dialect,
        saved: this.saved().includes(p.root),
        platformIcon: p.platform ? this.icons.uri(webview, 'icons', `platform-${p.platform}.svg`) : undefined,
        dialectIcon: DIALECT_ICONS[p.dialect] ? this.icons.uri(webview, 'icon-themes', 'atom', 'files', `${DIALECT_ICONS[p.dialect]}.svg`) : undefined,
      })),
      active: key,
      tools: TOOLS.map((t) => ({ id: t.id, label: t.label, short: t.short, key: t.key })),
      pane,
    });
  }

  /** New or deleted files of the active project reach the tree. */
  private watchFiles(root: string | undefined): void {
    this.filesWatcher?.dispose();
    this.filesWatcher = undefined;
    if (!root) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**'), false, true, false);
    const changed = (uri: vscode.Uri) => void this.view?.webview.postMessage({ type: 'refreshDir', dir: path.dirname(uri.fsPath) });
    this.filesWatcher = vscode.Disposable.from(w, w.onDidCreate(changed), w.onDidDelete(changed));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'icons'), vscode.Uri.joinPath(this.context.extensionUri, 'icon-themes')] };
    view.webview.html = stripHtml(view.webview);
    view.onDidDispose(() => {
      this.view = undefined;
      this.watchFiles(undefined);
    });
    view.webview.onDidReceiveMessage((m: { type: string; dir?: string; path?: string; root?: string; id?: string; endpoint?: unknown; action?: NodeAction; preset?: string }) => {
      switch (m.type) {
        case 'list':
          if (m.dir) void view.webview.postMessage({ type: 'entries', dir: m.dir, entries: this.icons.entriesOf(view.webview, m.dir) });
          break;
        case 'open':
          if (m.path) void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(m.path));
          break;
        case 'project':
          if (m.root) void this.go(m.root);
          break;
        case 'remove':
          if (m.root) void this.removeProject(m.root);
          break;
        case 'add':
          void this.openProject();
          break;
        case 'tool':
          if (m.id) void this.openTool(m.id);
          break;
        case 'action':
          void this.action(m.id);
          break;
        case 'endpoint':
          if (m.endpoint) void vscode.commands.executeCommand('nuclear.http.open', m.endpoint);
          break;
        case 'nodeAction':
          if (m.action?.type === 'updateContracts') void this.http.updateContracts(m.action.root, m.action.name);
          if (m.action?.type === 'addOpenApi') void this.http.addOpenApi();
          break;
        case 'environment':
          void this.http.selectEnvironment();
          break;
        case 'editEnvironments':
          void this.http.editEnvironments();
          break;
        case 'httpRefresh':
          this.http.refresh();
          break;
        case 'newDevice':
          void this.newDevice();
          break;
        case 'device':
          if (m.id) revealDevice(m.id);
          break;
        case 'closeDevice':
          void vscode.commands.executeCommand('nuclear.closeDevice', m.id);
          break;
        case 'runOnDevice':
          void this.mobileRoot().then(async (root) => {
            const p = root ? this.projects().find((x) => x.root === root) : undefined;
            if (p && (await this.inWorkspace(p, 'device'))) await vscode.commands.executeCommand('nuclear.runOnDevice', m.id, root);
          });
          break;
      }
    });
    this.refresh();
  }

  private async newDevice(): Promise<{ id: string } | undefined> {
    const pick = await vscode.window.showQuickPick(
      PRESETS.map((p) => ({ label: p.name, description: `${p.width}×${p.height} · ${p.os}`, name: p.name })),
      { placeHolder: 'Device to open (one more panel beside the others)' },
    );
    return pick ? vscode.commands.executeCommand<{ id: string }>('nuclear.openDevice', pick.name) : undefined;
  }
}

/** A project by its folder: the card when it exists, else `config.nuc` / `nuclear.toml` read directly. */
function projectAt(root: string): Project | undefined {
  const fromCard = readProject(root);
  if (fromCard) return fromCard;
  const read = (f: string) => {
    try {
      return fs.readFileSync(path.join(root, f), 'utf8');
    } catch {
      return undefined;
    }
  };
  const config = read('config.nuc');
  const toml = read('nuclear.toml');
  if (config === undefined && toml === undefined) return undefined;
  const take = (text: string | undefined, re: RegExp) => (text ? re.exec(text)?.[1] : undefined);
  return {
    root,
    name: take(config, /app\s*\([^)]*name\s*=\s*"([^"]+)"/) ?? take(toml, /^name\s*=\s*"([^"]+)"/m) ?? path.basename(root),
    platform: take(config, /platform\s*=\s*"([^"]+)"/) ?? null,
    dialect: take(config, /dialect\s*=\s*"([^"]+)"/) ?? take(toml, /^dialect\s*=\s*"([^"]+)"/m) ?? '',
    contracts: [],
  };
}

/**
 * The file tree wears the Chernobyl icon theme (the user's one when it is a Chernobyl variant, else the first), with the
 * same lookup VS Code's explorer does: file name, then the longest extension, then the default; folders by name, open or
 * closed. `files.exclude` (plain `**\/name` patterns) hides entries as in the explorer.
 */
class Icons {
  private theme: IconTheme = { iconDefinitions: {}, folderNames: {}, folderNamesExpanded: {}, fileNames: {}, fileExtensions: {}, folder: '', folderExpanded: '', file: '' };
  private excluded = new Set<string>();

  constructor(private readonly context: vscode.ExtensionContext) {
    this.load();
  }

  load(): void {
    const id = vscode.workspace.getConfiguration('workbench').get<string>('iconTheme');
    const slug = id === 'chernobyl-soft-icons' ? 'chernobyl-soft' : 'chernobyl';
    try {
      this.theme = JSON.parse(fs.readFileSync(path.join(this.context.extensionPath, 'icon-themes', `${slug}-icon-theme.json`), 'utf8')) as IconTheme;
    } catch {
      // the icons are generated by theme/icons.mjs; without them the tree has no icons
    }
    this.excluded = new Set(
      Object.entries(vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude', {}))
        .filter(([pattern, on]) => on && /^(\*\*\/)?[^*?{}[\]/]+$/.test(pattern))
        .map(([pattern]) => pattern.replace(/^\*\*\//, '')),
    );
  }

  uri(webview: vscode.Webview, ...parts: string[]): string {
    return webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...parts)).toString();
  }

  private icon(webview: vscode.Webview, id: string | undefined): string | undefined {
    const def = id ? this.theme.iconDefinitions[id] : undefined;
    return def ? this.uri(webview, 'icon-themes', ...def.iconPath.replace(/^\.\//, '').split('/')) : undefined;
  }

  entriesOf(webview: vscode.Webview, dir: string): Entry[] {
    const t = this.theme;
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.name !== '.git' && !this.excluded.has(e.name))
        .map((e) => {
          const lower = e.name.toLowerCase();
          if (e.isDirectory()) {
            return { name: e.name, dir: true, icon: this.icon(webview, t.folderNames[lower] ?? t.folder), iconOpen: this.icon(webview, t.folderNamesExpanded[lower] ?? t.folderExpanded) };
          }
          let id = t.fileNames[lower];
          const parts = lower.split('.');
          for (let i = 1; id === undefined && i < parts.length; i++) id = t.fileExtensions[parts.slice(i).join('.')];
          return { name: e.name, dir: false, icon: this.icon(webview, id ?? t.file) };
        })
        .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    } catch {
      return [];
    }
  }
}

interface IconTheme {
  iconDefinitions: Record<string, { iconPath: string }>;
  folderNames: Record<string, string>;
  folderNamesExpanded: Record<string, string>;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  folder: string;
  folderExpanded: string;
  file: string;
}

interface Entry {
  name: string;
  dir: boolean;
  icon?: string;
  iconOpen?: string;
}

// ---------------------------------------------------------------- the strip and the pane

/** The glyphs of the endpoints tree and the devices (16 px, stroke = currentColor), like VS Code's codicons. */
const GLYPHS: Record<string, string> = {
  backend: '<rect x="2" y="3" width="12" height="4" rx="1"/><rect x="2" y="9" width="12" height="4" rx="1"/><path d="M4.5 5h.01M4.5 11h.01" stroke-width="2"/>',
  mobile: '<rect x="4.5" y="1.5" width="7" height="13" rx="1.5"/><path d="M7 12.5h2"/>',
  web: '<circle cx="8" cy="8" r="6"/><ellipse cx="8" cy="8" rx="2.5" ry="6"/><path d="M2 8h12"/>',
  project: '<path d="M2 5l6-3 6 3v6l-6 3-6-3zM2 5l6 3 6-3M8 8v6"/>',
  component: '<path d="M6 2C4 2 4 3 4 4v2c0 1-1 2-2 2 1 0 2 1 2 2v2c0 1 0 2 2 2M10 2c2 0 2 1 2 2v2c0 1 1 2 2 2-1 0-2 1-2 2v2c0 1 0 2-2 2"/>',
  get: '<path d="M8 3v10M4 9l4 4 4-4"/>',
  post: '<path d="M8 13V3M4 7l4-4 4 4"/>',
  put: '<path d="M3 13l1-4 7-7 3 3-7 7z"/>',
  patch: '<path d="M3 13l1-4 7-7 3 3-7 7zM9 4l3 3"/>',
  delete: '<path d="M3 4h10M6 4V2h4v2M5 4l1 10h4l1-10"/>',
  law: '<path d="M4 2h6l3 3v9H4zM10 2v3h3M6 8h4M6 11h4"/>',
  check: '<path d="M3 8l3 3 7-7"/>',
  warning: '<path d="M8 2l6 12H2zM8 7v3M8 12v.5"/>',
  book: '<path d="M3 3h4a2 2 0 012 2v9a1 1 0 00-1-1H3zM13 3H9a2 2 0 00-2 2v9a1 1 0 011-1h5z"/>',
  cloud: '<path d="M5 13a3 3 0 010-6 4 4 0 017.7 1A2.5 2.5 0 0112 13z"/>',
  tag: '<path d="M2 2h6l6 6-6 6-6-6zM5 5h.5"/>',
  // the tools of the strip
  http: '<path d="M2 5h9M8 2l3 3-3 3M14 11H5M8 8l-3 3 3 3"/>',
  devices: '<rect x="1.5" y="3" width="8" height="11" rx="1.5"/><path d="M4.5 12h2M9.5 5h3a2 2 0 012 2v5a2 2 0 01-2 2h-3"/>',
  designer: '<rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M2 6h12M6 6v8"/>',
  docs: '<path d="M4 2h6l3 3v9H4zM10 2v3h3M6 8h5M6 11h5"/>',
  agent: '<path d="M8 1.5l1.4 3.6L13 6.5l-3.6 1.4L8 11.5 6.6 7.9 3 6.5l3.6-1.4zM12.5 10.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
  info: '<circle cx="8" cy="8" r="6.5"/><path d="M8 7v4M8 5v.5"/>',
  device: '<rect x="4" y="1.5" width="8" height="13" rx="1.5"/><path d="M7 12.5h2"/>',
};

function stripHtml(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2);
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<style>
  html, body { height: 100%; margin: 0; }
  body { display: flex; height: 100vh; font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); overflow: hidden; }
  .strip { width: 42px; flex: none; display: flex; flex-direction: column; background: var(--vscode-sideBarSectionHeader-background); border-right: 1px solid var(--vscode-sideBarSectionHeader-border, transparent); overflow: hidden auto; }
  .tools { margin-top: auto; padding-bottom: 6px; flex: none; }
  .tab { position: relative; width: 32px; height: 32px; margin: 5px auto 0; border-radius: 5px; display: grid; place-items: center; font-size: 10px; font-weight: 600; cursor: pointer; opacity: .7; user-select: none; letter-spacing: .02em; }
  .tab:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
  .tab.on { opacity: 1; background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }
  .tab .n { position: absolute; left: 2px; top: 1px; font-size: 8px; opacity: .6; font-weight: 400; }
  .tab img.pi { width: 20px; height: 20px; }
  .tab img.di { position: absolute; right: -3px; bottom: -3px; width: 14px; height: 14px; border-radius: 3px; background: var(--vscode-sideBar-background); padding: 1px; }
  .tab svg.g { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .tab.t-http { color: var(--vscode-nuclearHttp-get); } .tab.t-devices { color: var(--vscode-nuclearHttp-platform); }
  .tab.t-designer { color: var(--vscode-nuclearHttp-put); } .tab.t-docs { color: var(--vscode-nuclearHttp-component); } .tab.t-agent { color: var(--vscode-nuclearHttp-post); }
  .tab.add { opacity: .5; font-size: 16px; font-weight: 300; border: 1px dashed currentColor; }
  .tab.add:hover { opacity: 1; }
  .pane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .head { padding: 6px 10px 4px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; opacity: .75; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: none; }
  .head b { font-weight: 600; }
  .actions { display: flex; flex-wrap: wrap; gap: 4px; padding: 2px 8px 6px; flex: none; }
  .actions button { font-family: inherit; font-size: 11px; padding: 2px 7px; border-radius: 3px; border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); cursor: pointer; }
  .actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .actions button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .envbar { display: flex; align-items: center; gap: 6px; padding: 2px 10px 6px; font-size: 11px; opacity: .85; flex: none; }
  .envbar a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .tree { flex: 1; overflow: auto; }
  .row { display: flex; align-items: center; gap: 3px; height: 22px; line-height: 22px; white-space: nowrap; cursor: pointer; padding-right: 6px; }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .row.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); }
  .row .c { width: 14px; flex: none; text-align: center; font-size: 10px; opacity: .7; transition: transform .1s; }
  .row.open .c { transform: rotate(90deg); }
  .row img.i { width: 16px; height: 16px; flex: none; margin-right: 2px; }
  .row svg.g { width: 16px; height: 16px; flex: none; margin-right: 3px; fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linecap: round; stroke-linejoin: round; }
  .row .name { overflow: hidden; text-overflow: ellipsis; }
  .row .desc { opacity: .55; font-size: 11px; margin-left: 4px; overflow: hidden; text-overflow: ellipsis; }
  .row .btn { margin-left: auto; font-size: 11px; padding: 0 6px; border-radius: 3px; opacity: 0; background: var(--vscode-toolbar-hoverBackground); }
  .row:hover .btn { opacity: 1; }
  .row.dir .name { font-weight: 500; }
  .row.nuc .name { color: var(--vscode-nuclearHttp-project); }
  .c-platform { color: var(--vscode-nuclearHttp-platform); } .c-project { color: var(--vscode-nuclearHttp-project); } .c-component { color: var(--vscode-nuclearHttp-component); }
  .c-get { color: var(--vscode-nuclearHttp-get); } .c-post { color: var(--vscode-nuclearHttp-post); } .c-put { color: var(--vscode-nuclearHttp-put); } .c-patch { color: var(--vscode-nuclearHttp-patch); } .c-delete { color: var(--vscode-nuclearHttp-delete); }
  .row.ep .name { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .row.ep .verb { font-weight: 700; font-size: 11px; width: 44px; flex: none; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; margin: 0 6px 0 4px; background: var(--vscode-disabledForeground); }
  .dot.live { background: var(--vscode-testing-iconPassed); } .dot.starting { background: var(--vscode-nuclearHttp-put); } .dot.hidden { background: var(--vscode-nuclearHttp-platform); opacity: .6; }
  .empty { padding: 12px 10px; opacity: .7; line-height: 1.5; }
  .empty a { color: var(--vscode-textLink-foreground); cursor: pointer; }
  .toast { position: fixed; left: 48px; bottom: 10px; max-width: calc(100% - 60px); padding: 6px 10px; border-radius: 4px; font-size: 12px; background: var(--vscode-notifications-background); color: var(--vscode-notifications-foreground); border: 1px solid var(--vscode-notifications-border, var(--vscode-widget-border, transparent)); box-shadow: 0 2px 8px rgba(0,0,0,.3); opacity: 0; transition: opacity .15s; pointer-events: none; z-index: 2; }
  .toast.on { opacity: 1; }
  .toast kbd { font-family: var(--vscode-editor-font-family); font-weight: 600; }
</style>
</head>
<body>
  <div class="strip"><div id="projects"></div><div class="tools" id="tools"></div></div>
  <div class="pane" id="pane"></div>
  <div class="toast" id="toast"></div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const GLYPHS = ${JSON.stringify(GLYPHS)};
  const $ = (id) => document.getElementById(id);
  let state = { projects: [], active: '', tools: [], pane: { kind: 'files' } };
  const loaded = {};          // dir -> entries
  const expanded = new Set(); // absolute paths of open folders
  const collapsed = new Set(); // tree node ids the user closed (nodes start open)
  let selected = '';
  let toastTimer;
  const el = (tag, cls, text) => { const d = document.createElement(tag); if (cls) d.className = cls; if (text !== undefined) d.textContent = text; return d; };

  function toast(key, what) {
    const t = $('toast');
    t.innerHTML = '<kbd></kbd> ';
    t.firstChild.textContent = key;
    t.appendChild(document.createTextNode(what + ' without the mouse'));
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
  }
  function initials(name) {
    const parts = name.replace(/[_-]+/g, ' ').trim().split(/\\s+/);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : name.slice(0, 2)).toUpperCase();
  }
  function tab(text, title, on) {
    const d = el('div', 'tab' + (on ? ' on' : ''), text);
    d.title = title;
    return d;
  }
  function glyph(name, cls) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('class', 'g ' + (cls || ''));
    s.innerHTML = GLYPHS[name] || GLYPHS.info;
    return s;
  }

  // ---------- the strip ----------
  function renderStrip() {
    const ps = $('projects');
    ps.innerHTML = '';
    state.projects.forEach((p, i) => {
      const key = i < 9 ? 'Ctrl+' + (i + 1) : '';
      const t = tab(p.platformIcon ? '' : initials(p.name), p.name + ' · ' + (p.platform || '') + ' ' + p.dialect + (key ? '  (' + key + ')' : '') + (p.saved ? '\\nright click: remove from the workspace' : ''), p.root === state.active);
      if (p.platformIcon) { const pi = el('img', 'pi'); pi.src = p.platformIcon; t.appendChild(pi); }
      if (p.dialectIcon) { const di = el('img', 'di'); di.src = p.dialectIcon; t.appendChild(di); }
      if (key) t.appendChild(el('span', 'n', String(i + 1)));
      t.addEventListener('click', () => { vscode.postMessage({ type: 'project', root: p.root }); if (key) toast(key, 'opens ' + p.name); });
      if (p.saved) t.addEventListener('contextmenu', (ev) => { ev.preventDefault(); vscode.postMessage({ type: 'remove', root: p.root }); });
      ps.appendChild(t);
    });
    const add = tab('+', 'Open a project as a tab  (Ctrl+Alt+O)', false);
    add.classList.add('add');
    add.addEventListener('click', () => { vscode.postMessage({ type: 'add' }); toast('Ctrl+Alt+O', 'opens a project'); });
    ps.appendChild(add);
    const ts = $('tools');
    ts.innerHTML = '';
    for (const tool of state.tools) {
      const t = tab('', tool.label + '  (' + tool.key + ')', state.active === 'tool:' + tool.id);
      t.classList.add('t-' + tool.id);
      t.appendChild(glyph(tool.id));
      t.addEventListener('click', () => { vscode.postMessage({ type: 'tool', id: tool.id }); toast(tool.key, 'opens the ' + tool.label.toLowerCase()); });
      ts.appendChild(t);
    }
  }

  // ---------- the pane ----------
  function renderPane() {
    const pane = $('pane');
    pane.innerHTML = '';
    const p = state.pane;
    if (p.kind === 'files') renderFiles(pane, p);
    else if (p.kind === 'tree') renderHttp(pane, p);
    else if (p.kind === 'devices') renderDevices(pane, p);
    else renderTemplate(pane, p);
  }
  function head(pane, name, rest) {
    const h = el('div', 'head');
    h.appendChild(el('b', '', name));
    if (rest) h.appendChild(document.createTextNode(' · ' + rest));
    pane.appendChild(h);
  }

  // the files of the active project (its actions are in the editor title bar)
  function renderFiles(pane, p) {
    if (!p.project) {
      head(pane, 'Nuclear workspace');
      const e = el('div', 'empty');
      e.innerHTML = 'No Nuclear project here yet. <a id="addLink">Open one</a> as a tab (Ctrl+Alt+O), or open a folder with a <code>config.nuc</code>.';
      pane.appendChild(e);
      $('addLink').addEventListener('click', () => vscode.postMessage({ type: 'add' }));
      return;
    }
    head(pane, p.project.name, (p.project.platform || '') + ' ' + p.project.dialect);
    const tree = el('div', 'tree'); tree.id = 'tree';
    pane.appendChild(tree);
    renderTree();
  }
  function need(dir) { if (!(dir in loaded)) { loaded[dir] = null; vscode.postMessage({ type: 'list', dir }); } }
  function rows(dir, depth, out) {
    const entries = loaded[dir];
    if (!entries) { need(dir); return; }
    for (const e of entries) {
      const full = dir.replace(/[\\\\/]$/, '') + '/' + e.name;
      out.push({ full, name: e.name, dir: e.dir, depth, icon: e.dir && expanded.has(full) ? e.iconOpen : e.icon });
      if (e.dir && expanded.has(full)) rows(full, depth + 1, out);
    }
  }
  function renderTree() {
    const tree = $('tree');
    if (!tree || state.pane.kind !== 'files' || !state.pane.project) return;
    const list = [];
    rows(state.pane.project.root, 0, list);
    tree.innerHTML = '';
    for (const r of list) {
      const d = el('div', 'row' + (r.dir ? ' dir' : '') + (expanded.has(r.full) ? ' open' : '') + (r.full === selected ? ' sel' : '') + (r.name.endsWith('.nuc') ? ' nuc' : ''));
      d.style.paddingLeft = (6 + r.depth * 12) + 'px';
      d.appendChild(el('span', 'c', r.dir ? '▶' : ''));
      if (r.icon) { const i = el('img', 'i'); i.src = r.icon; d.appendChild(i); }
      d.appendChild(el('span', 'name', r.name));
      d.title = r.full;
      d.addEventListener('click', () => {
        selected = r.full;
        if (r.dir) { expanded.has(r.full) ? expanded.delete(r.full) : expanded.add(r.full); }
        else vscode.postMessage({ type: 'open', path: r.full });
        renderTree();
      });
      tree.appendChild(d);
    }
  }

  // the endpoints tree of the HTTP tool
  function renderHttp(pane, p) {
    head(pane, 'HTTP', 'every project');
    const bar = el('div', 'envbar');
    bar.appendChild(document.createTextNode('env '));
    bar.appendChild(el('b', '', p.environment));
    for (const [label, type, title] of [['change', 'environment', 'Select or create an environment'], ['edit', 'editEnvironments', 'Variables, headers, base urls (.nuclear/http.json)'], ['↻', 'httpRefresh', 'Refresh']]) {
      bar.appendChild(document.createTextNode(' · '));
      const a = el('a', '', label); a.title = title; a.addEventListener('click', () => vscode.postMessage({ type })); bar.appendChild(a);
    }
    pane.appendChild(bar);
    const tree = el('div', 'tree');
    pane.appendChild(tree);
    if (!p.nodes.length) tree.appendChild(el('div', 'empty', 'No Nuclear project found: build one (nuclear build / dragonfly build) or add an OpenAPI document.'));
    const walk = (nodes, depth) => {
      for (const n of nodes) {
        const kids = n.children && n.children.length ? n.children : null;
        const open = kids && !collapsed.has(n.id);
        const d = el('div', 'row' + (n.endpoint ? ' ep' : '') + (open ? ' open' : '') + (n.id === selected ? ' sel' : ''));
        d.style.paddingLeft = (6 + depth * 12) + 'px';
        d.appendChild(el('span', 'c', kids ? '▶' : ''));
        if (n.endpoint) {
          d.appendChild(el('span', 'verb c-' + n.icon, n.endpoint.verb.toUpperCase()));
          d.appendChild(el('span', 'name', n.endpoint.path));
        } else {
          d.appendChild(glyph(n.icon, n.color ? 'c-' + n.color : ''));
          d.appendChild(el('span', 'name', n.label));
        }
        if (n.desc) d.appendChild(el('span', 'desc', n.desc));
        if (n.button) { const b = el('span', 'btn', n.button.label); b.title = n.button.title; b.addEventListener('click', (ev) => { ev.stopPropagation(); vscode.postMessage({ type: 'nodeAction', action: n.button.action }); }); d.appendChild(b); }
        d.title = n.tooltip || n.label;
        d.addEventListener('click', () => {
          selected = n.id;
          if (n.endpoint) vscode.postMessage({ type: 'endpoint', endpoint: n.endpoint });
          else if (kids) { collapsed.has(n.id) ? collapsed.delete(n.id) : collapsed.add(n.id); }
          renderPane();
        });
        tree.appendChild(d);
        if (open) walk(kids, depth + 1);
      }
    };
    walk(p.nodes, 0);
  }

  // the devices
  function renderDevices(pane, p) {
    head(pane, 'Devices', p.project ? 'runs ' + p.project : '');
    const bar = el('div', 'actions');
    const add = el('button', 'primary', '+ New device');
    add.title = 'One more Dragonfly device beside the code (pick its size and identity)';
    add.addEventListener('click', () => vscode.postMessage({ type: 'newDevice' }));
    bar.appendChild(add);
    pane.appendChild(bar);
    const tree = el('div', 'tree');
    pane.appendChild(tree);
    if (!p.devices.length) tree.appendChild(el('div', 'empty', 'No device. Open several to try different clients at the same time, like emulators; each keeps its own app and session. Closing a device tab only hides it; ✕ here ends it. A device nobody looks at for 30 minutes ends by itself.'));
    for (const d of p.devices) {
      const r = el('div', 'row');
      r.style.paddingLeft = '6px';
      r.appendChild(glyph('device', 'c-platform'));
      r.appendChild(el('span', 'name', d.title));
      r.appendChild(el('span', 'dot ' + d.status));
      r.appendChild(el('span', 'desc', d.status));
      const run = el('span', 'btn', '▷ run'); run.title = 'Run the project on this device' + (p.project ? ' (' + p.project + ')' : '');
      run.addEventListener('click', (ev) => { ev.stopPropagation(); vscode.postMessage({ type: 'runOnDevice', id: d.id }); });
      r.appendChild(run);
      const close = el('span', 'btn', '✕'); close.title = 'Close this device: its app and processes end now (closing its tab only hides it)';
      close.addEventListener('click', (ev) => { ev.stopPropagation(); vscode.postMessage({ type: 'closeDevice', id: d.id }); });
      r.appendChild(close);
      r.title = d.status === 'hidden' ? 'Show this device again' : 'Show this device';
      r.addEventListener('click', () => vscode.postMessage({ type: 'device', id: d.id }));
      tree.appendChild(r);
    }
  }

  function renderTemplate(pane, p) {
    head(pane, p.tool.label, 'template');
    const e = el('div', 'empty');
    e.appendChild(document.createTextNode(p.tool.about + ' '));
    const a = el('a', '', 'Open it'); a.addEventListener('click', () => vscode.postMessage({ type: 'tool', id: p.tool.id }));
    e.appendChild(a); e.appendChild(document.createTextNode(' (' + p.tool.key + ').'));
    pane.appendChild(e);
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'state') { state = m; renderStrip(); renderPane(); }
    if (m.type === 'entries') { loaded[m.dir] = m.entries; renderTree(); }
    if (m.type === 'refreshDir') { if (m.dir in loaded) { delete loaded[m.dir]; renderTree(); } }
  });
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------- welcome and tool pages

const SHORTCUTS: [string, string][] = [
  ['Ctrl+Alt+N', 'show the Nuclear workspace (the strip and the pane)'],
  ['Ctrl+1 … Ctrl+9', 'the first to the ninth project tab'],
  ['Ctrl+Alt+O', 'open a project as a new tab'],
  ...TOOLS.map((t): [string, string] => [t.key, t.label.toLowerCase()]),
  ['Ctrl+Alt+R / G / L', 'run, debug, hot reload the active project (what its platform has)'],
  ['Ctrl+Alt+B / T / C', 'build, test, check the active project'],
  ['Ctrl+Alt+W', 'this page'],
];

function page(webview: vscode.Webview, title: string, body: string, nonce: string): string {
  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); max-width: 820px; margin: 0 auto; padding: 32px 24px 48px; line-height: 1.5; }
  h1 { font-weight: 600; font-size: 26px; margin: 0 0 4px; display: flex; align-items: center; gap: 14px; }
  h1 img { width: 44px; height: 44px; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .06em; opacity: .7; margin: 28px 0 8px; }
  .lead { font-size: 15px; opacity: .9; margin: 0 0 6px; }
  .muted { opacity: .7; font-size: 12px; }
  kbd { font-family: var(--vscode-editor-font-family); font-size: 12px; padding: 1px 6px; border-radius: 3px; background: var(--vscode-keybindingLabel-background); color: var(--vscode-keybindingLabel-foreground); border: 1px solid var(--vscode-keybindingLabel-border); border-bottom-color: var(--vscode-keybindingLabel-bottomBorder); white-space: nowrap; }
  table { border-collapse: collapse; } td { padding: 3px 14px 3px 0; vertical-align: top; }
  .project { display: flex; align-items: center; gap: 12px; padding: 8px 10px; border-radius: 6px; cursor: pointer; border: 1px solid var(--vscode-widget-border, transparent); margin-bottom: 6px; }
  .project:hover { background: var(--vscode-list-hoverBackground); }
  .project.on { box-shadow: inset 3px 0 0 var(--vscode-focusBorder); }
  .project .name { font-weight: 600; } .project .path { opacity: .6; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .project .grow { flex: 1; min-width: 0; }
  button { font-family: inherit; font-size: 13px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 3px; padding: 6px 14px; cursor: pointer; }
  button.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  ul { padding-left: 20px; } li { margin: 2px 0; }
  code { font-family: var(--vscode-editor-font-family); font-size: 12px; }
  .template { border: 1px dashed var(--vscode-widget-border, #888); border-radius: 6px; padding: 14px 18px; margin-top: 18px; }
  label { display: flex; gap: 8px; align-items: center; cursor: pointer; }
</style>
<title>${title}</title>
</head>
<body>${body}</body>
</html>`;
}

class WelcomePanel {
  private static current: WelcomePanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private readonly listener: vscode.Disposable;

  private constructor(private readonly context: vscode.ExtensionContext, private readonly ws: Workspace) {
    this.panel = vscode.window.createWebviewPanel('nuclear.welcome', 'Nuclear workspace', vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'icons')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icons', 'nuc-file.svg');
    this.listener = ws.onDidChange.event(() => this.render());
    this.panel.onDidDispose(() => {
      WelcomePanel.current = undefined;
      this.listener.dispose();
    });
    this.panel.webview.onDidReceiveMessage((m: { type: string; root?: string; on?: boolean }) => {
      if (m.type === 'project' && m.root) void ws.go(m.root);
      if (m.type === 'open') void ws.openProject();
      if (m.type === 'startup') void vscode.workspace.getConfiguration().update(WELCOME, m.on, vscode.ConfigurationTarget.Global);
    });
    this.render();
  }

  static show(context: vscode.ExtensionContext, ws: Workspace): void {
    if (!WelcomePanel.current) WelcomePanel.current = new WelcomePanel(context, ws);
    else WelcomePanel.current.panel.reveal();
  }

  private render(): void {
    const nonce = Math.random().toString(36).slice(2);
    const logo = this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'icons', 'icon.svg'));
    const active = this.ws.activeKey();
    const projects = this.ws.projects();
    const list = projects.length
      ? projects
          .map(
            (p, i) => `<div class="project${p.root === active ? ' on' : ''}" data-root="${esc(p.root)}">
  ${i < 9 ? `<kbd>Ctrl+${i + 1}</kbd>` : '<kbd> </kbd>'}
  <div class="grow"><div class="name">${esc(p.name)} <span class="muted">${esc(p.platform ?? '')} · ${esc(p.dialect)}</span></div><div class="path">${esc(p.root)}</div></div>
</div>`,
          )
          .join('')
      : '<p class="muted">No Nuclear project in this window yet: open one below, or a folder with a <code>config.nuc</code>.</p>';
    const body = `
<h1><img src="${logo}" alt=""> Nuclear workspace</h1>
<p class="lead">Everything of Nuclear meets in one place: the <b>Nuclear</b> container of the activity bar (<kbd>Ctrl+Alt+N</kbd>).</p>
<p>Every tab of its strip is a workspace of its own: a <b>project</b> (its files, and the actions of its platform: run,
debug, hot reload, device, build, test, check) or a <b>tool</b> (the HTTP client with its endpoints tree, the devices, …).
Switching tabs swaps the editor area; only the devices stay beside the code, like emulators. Opening a project adds a
tab, not a window. VS Code's explorer, search and git stay as they are; <i>Nuclear: Add the Active Project to the VS Code
Workspace</i> adds a tab's folder when you want them.</p>
<h2>Projects</h2>
${list}
<p><button id="open">Open a project as a tab…</button> <span class="muted">Ctrl+Alt+O</span></p>
<h2>Keyboard first</h2>
<table>${SHORTCUTS.map(([k, w]) => `<tr><td><kbd>${k}</kbd></td><td>${w}</td></tr>`).join('')}</table>
<p class="muted">Clicking a tab or an action shows the shortcut that does the same; the bindings can be changed in <i>Keyboard Shortcuts</i> (search "nuclear").</p>
<h2>Tools</h2>
<table>${TOOLS.map((t) => `<tr><td><kbd>${t.key}</kbd></td><td><b>${esc(t.label)}</b>${t.planned.length ? ' <span class="muted">(template)</span>' : ''}<br><span class="muted">${esc(t.about)}</span></td></tr>`).join('')}</table>
<h2>Startup</h2>
<label><input type="checkbox" id="startup" ${vscode.workspace.getConfiguration().get<boolean>(WELCOME, true) ? 'checked' : ''}> Show this page when VS Code starts with no editor open (<code>nuclear.workspace.welcome</code>)</label>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('.project').forEach((p) => p.addEventListener('click', () => vscode.postMessage({ type: 'project', root: p.dataset.root })));
  document.getElementById('open').addEventListener('click', () => vscode.postMessage({ type: 'open' }));
  document.getElementById('startup').addEventListener('change', (ev) => vscode.postMessage({ type: 'startup', on: ev.target.checked }));
</script>`;
    this.panel.webview.html = page(this.panel.webview, 'Nuclear workspace', body, nonce);
  }
}

/** A tool that is not built yet: its page says what it will do, full screen, with its shortcut. */
class ToolPanel {
  private static open = new Map<string, vscode.WebviewPanel>();

  static show(context: vscode.ExtensionContext, tool: Tool): void {
    const existing = ToolPanel.open.get(tool.id);
    if (existing) {
      existing.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(`nuclear.tool.${tool.id}`, tool.label, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icons', 'nuc-file.svg');
    ToolPanel.open.set(tool.id, panel);
    panel.onDidDispose(() => ToolPanel.open.delete(tool.id));
    panel.webview.onDidReceiveMessage((m: { type: string }) => {
      if (m.type === 'settings') void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:nuclearlang.nuclearlang');
    });
    const nonce = Math.random().toString(36).slice(2);
    const body = `
<h1>${esc(tool.label)}</h1>
<p class="lead">${esc(tool.about)}</p>
<p class="muted">Shortcut <kbd>${tool.key}</kbd> · the strip of the Nuclear workspace (<kbd>Ctrl+Alt+N</kbd>), at the bottom.</p>
<div class="template">
  <p><b>This tool is a template.</b> The window layout is in place; what it will do:</p>
  <ul>${tool.planned.map((p) => `<li>${esc(p).replace(/`([^`]+)`/g, '<code>$1</code>')}</li>`).join('')}</ul>
  ${tool.id === 'settings' ? '<p><button id="settings">Open the extension settings for now</button></p>' : ''}
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.getElementById('settings')?.addEventListener('click', () => vscode.postMessage({ type: 'settings' }));
</script>`;
    panel.webview.html = page(panel.webview, tool.label, body, nonce);
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
