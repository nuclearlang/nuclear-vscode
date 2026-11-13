// VS Code client for the NuclearLang language server (nuclear-lsp).

import { SettingsPanel } from './settingsPanel';
import { SetupPanel } from './setupPanel';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { activateDebug } from './debug';
import { activateDevice } from './device';
import { activateHttp } from './http';
import { appDir, CARD, projectCard, readCard } from './card';
import { activateWebDevice } from './webDevice';
import { activateWorkspace } from './workspace';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

const GENERATED_SCHEME = 'nuclear-generated';

let client: LanguageClient | undefined;
let statusItem: vscode.StatusBarItem;
let generated: GeneratedCodeProvider;
let metricsDecoration: CodeMetricsDecoration;
let debugNuc: { built(): void } | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  generated = new GeneratedCodeProvider();
  metricsDecoration = new CodeMetricsDecoration();
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(statusItem);
  // the server writes the project card when it builds a project: the status bar follows it
  const cards = vscode.workspace.createFileSystemWatcher(`**/${CARD}`);
  context.subscriptions.push(cards, cards.onDidCreate(updateStatus), cards.onDidChange(updateStatus), cards.onDidDelete(updateStatus));

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(GENERATED_SCHEME, generated),
    vscode.commands.registerCommand('nuclear.showGeneratedCode', showGeneratedCode),
    vscode.commands.registerCommand('nuclear.selectDialect', selectDialect),
    vscode.commands.registerCommand('nuclear.showCodeMetricsCodeLensInfo', showCodeMetricsDetails),
    metricsDecoration,
    vscode.commands.registerCommand('nuclear.restartServer', async () => {
      await stopClient();
      await startClient(context);
    }),
    // from the editor title the argument is the file's uri; from the Nuclear workspace, the project's root
    vscode.commands.registerCommand('nuclear.run', (arg?: unknown) => runApp(true, undefined, {}, typeof arg === 'string' ? arg : undefined)),
    vscode.commands.registerCommand('nuclear.debug', (arg?: unknown) => runApp(false, undefined, {}, typeof arg === 'string' ? arg : undefined)),
    vscode.debug.registerDebugConfigurationProvider('dragonfly', dragonflyDebugProvider),
    vscode.debug.registerDebugAdapterTrackerFactory('dart', { createDebugAdapterTracker: watchSession }),
    vscode.debug.onDidTerminateDebugSession(sessionEnded),
    vscode.workspace.onDidSaveTextDocument(reloadOnSave),
    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidChangeTextDocument((e) => generated.sourceChanged(e.document)),
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (e.affectsConfiguration('nuclear.server.path')) {
        await stopClient();
        await startClient(context);
      }
      if (e.affectsConfiguration('nuclear.dialect')) {
        updateStatus();
        generated.refreshAll();
      }
      if (e.affectsConfiguration('nuclear.codemetrics')) {
        metricsDecoration.reset();
      }
    }),
  );

  await startClient(context);
  watchIdle(context);
  updateStatus();
  updateRunContext();
  watchAppCreation(context);
  // the project of a folder (a session's cwd, a breakpoint's file), or the first one of the workspace
  debugNuc = activateDebug(context, (dir?: string) => (dir ? dragonflyOf(path.join(dir, '_')) : findDragonfly()));
  const http = activateHttp(context);
  activateWorkspace(context, http);
  // the set-up of the AI services (ADR-0106): a command, and an offer on a machine that was never set up
  context.subscriptions.push(vscode.commands.registerCommand('nuclear.ai.setup', () => SetupPanel.show()));
  void SetupPanel.offer(context);
  activateDevice(context, findDragonfly, (deviceId, extra, root, noDebug) => runApp(noDebug ?? false, deviceId, extra, root));
  // a web project's app: from the workspace `dragonfly build` writes, or (never built yet) its default place
  // a web project's app: its card (output, toolchain) and the dragonfly of its workspace (else the one on the PATH)
  activateWebDevice(context, (root) => {
    const card = readCard(root);
    const app = appDir(root, card);
    if (!card || !app) return undefined;
    return { root, app, dragonfly: findDragonfly(root)?.dragonfly ?? 'dragonfly', name: card.name, serve: card.toolchain?.serve ?? undefined };
  });
}

// ---------------------------------------------------------------- run (Dragonfly projects)

// A Dragonfly project is a folder with build/<name>.code-workspace, which every `dragonfly build` writes.
// That file names the Flutter app, the dragonfly binary and the launch config, so Run/Debug, F5 and hot
// reload work the same whether the user opened the workspace or just the project folder.
interface Dragonfly {
  root: string;
  app: string;
  dragonfly: string;
  env: Record<string, string>;
  launch: vscode.DebugConfiguration;
}

let dragonflyOutput: vscode.OutputChannel | undefined;
let buildQueue: Promise<number> = Promise.resolve(0);
let appAtStart = false;

/** The Dragonfly project of `root`, or the first one of the workspace folders. */
function findDragonfly(root?: string): Dragonfly | undefined {
  const roots = root ? [root] : (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  for (const folder of roots) {
    const build = path.join(folder, 'build');
    let names: string[];
    try {
      names = fs.readdirSync(build).filter((n) => n.endsWith('.code-workspace'));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const ws = JSON.parse(fs.readFileSync(path.join(build, name), 'utf8'));
        const folders: Record<string, string> = {};
        for (const f of ws.folders ?? []) folders[f.name] = path.resolve(build, f.path);
        const resolve = (v: unknown): unknown =>
          typeof v === 'string'
            ? v.replace(/\$\{workspaceFolder:([^}]+)\}/g, (all, n: string) => folders[n] ?? all)
            : Array.isArray(v)
              ? v.map(resolve)
              : v && typeof v === 'object'
                ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolve(x)]))
                : v;
        // the app's debug launch: dart (mobile), node (nestjs), debugpy (fastapi) or chrome (react)
        const launch = (ws.launch?.configurations ?? []).find((c: { name?: string }) => c.name?.endsWith(' (debug)'));
        const task = (ws.tasks?.tasks ?? []).find((t: { label?: string }) => t.label === 'dragonfly: build');
        if (!launch || !task) continue;
        const resolved = resolve(launch) as vscode.DebugConfiguration;
        return {
          root: folder,
          app: resolved.cwd ?? resolved.webRoot,
          dragonfly: task.command,
          env: task.options?.env ?? {},
          launch: resolved,
        };
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

/** The Dragonfly project a file belongs to (walking up), also when its folder is not a workspace folder. */
function dragonflyOf(file: string): Dragonfly | undefined {
  let dir = path.dirname(file);
  for (let i = 0; i < 8; i++) {
    const d = findDragonfly(dir);
    if (d) return d;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

function updateRunContext(): void {
  void vscode.commands.executeCommand('setContext', 'nuclear.canRun', findDragonfly() !== undefined);
}

/** Exit code of `dragonfly build` when the `.nuc` have errors: repairing the app cannot fix them. */
const CODE_ERRORS = 2;

/** `dragonfly <command>` (build: transpile, plus pub get and build_runner when needed); one at a time.
 * Resolves to the exit code (0 = ok). */
function dragonfly(d: Dragonfly, command: 'build' | 'repair' = 'build'): Promise<number> {
  const out = (dragonflyOutput ??= vscode.window.createOutputChannel('Dragonfly'));
  buildQueue = buildQueue.then(
    () =>
      new Promise<number>((done) => {
        const env = { ...process.env, ...d.env, NO_COLOR: '1' };
        execFile(d.dragonfly, [command], { cwd: d.root, env, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
          out.append(stdout + stderr);
          if (!err) debugNuc?.built();
          done(err ? (typeof err.code === 'number' ? err.code : 1) : 0);
        });
      }),
  );
  return buildQueue;
}

const dragonflyBuild = (d: Dragonfly) => dragonfly(d, 'build');

/** `dragonfly repair`, only when something failed: build; pub get + build_runner from scratch; flutter clean
 * and everything again; each step only if the one before did not leave a valid app. */
function dragonflyRepair(d: Dragonfly, why: string): Thenable<boolean> {
  dragonflyOutput?.appendLine(`\n--- ${why}: dragonfly repair`);
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Dragonfly: ${why}, repairing the app…` },
    async () => (await dragonfly(d, 'repair')) === 0,
  );
}

async function showBuildError(message: string): Promise<void> {
  const choice = await vscode.window.showErrorMessage(`Dragonfly: ${message}`, 'Show Output');
  if (choice) dragonflyOutput?.show();
}

/** The app's launch config with the given mode; the project is transpiled first (no preLaunchTask, so it
 * also works without the workspace's tasks). */
async function dragonflyLaunch(d: Dragonfly, base: vscode.DebugConfiguration): Promise<vscode.DebugConfiguration | undefined> {
  const code = await dragonflyBuild(d);
  if (code === CODE_ERRORS) {
    await showBuildError('the project has errors.');
    return undefined;
  }
  if (code !== 0 && !(await dragonflyRepair(d, 'the build failed'))) {
    await showBuildError('the build fails even after flutter clean.');
    return undefined;
  }
  const config: vscode.DebugConfiguration = { ...d.launch, ...base, type: 'dart', request: 'launch' };
  config.name = base.name || d.launch.name;
  config.program = d.launch.program;
  config.cwd = d.app;
  config.flutterMode = base.flutterMode ?? d.launch.flutterMode;
  delete config.preLaunchTask;
  return config;
}

/** `root`: the project (a tab of the Nuclear workspace); without it, the first Dragonfly project of the folders. */
async function runApp(noDebug: boolean, deviceId?: string, extra: Record<string, unknown> = {}, root?: string): Promise<void> {
  const d = findDragonfly(root);
  if (!d) {
    void vscode.window.showWarningMessage('Not a Dragonfly project: run `dragonfly build` in the project first.');
    return;
  }
  if (d.launch.type !== 'dart') return runPlatformApp(d, noDebug);
  const config = await dragonflyLaunch(d, { type: 'dart', request: 'launch', name: d.launch.name, ...(deviceId && { deviceId }), ...extra });
  if (config) await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(d.app)), config, { noDebug });
}

/** A backend or web app (the launch the CLI wrote for its dialect): build, then that launch. A web app's dev server
 * runs first in its terminal (`dragonfly run`), as the launch's preLaunchTask would. */
async function runPlatformApp(d: Dragonfly, noDebug: boolean): Promise<void> {
  const code = await dragonflyBuild(d);
  if (code !== 0) return showBuildError(code === CODE_ERRORS ? 'the project has errors.' : 'the build failed.');
  const config: vscode.DebugConfiguration = { ...d.launch };
  if (config.type === 'chrome' && typeof config.url === 'string') {
    const name = `${path.basename(d.root)} · run`;
    const terminal = vscode.window.terminals.find((t) => t.name === name) ?? vscode.window.createTerminal({ name, cwd: d.root });
    if (!(await answers(config.url))) {
      terminal.sendText(`"${d.dragonfly}" run`);
      if (!(await answers(config.url, 120))) return showBuildError(`the dev server did not answer at ${config.url}.`);
    }
  }
  delete config.preLaunchTask;
  await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(d.root)), config, { noDebug });
}

/** Whether `url` answers, waiting up to `seconds`. */
async function answers(url: string, seconds = 0): Promise<boolean> {
  for (let i = 0; i <= seconds * 2; i++) {
    try {
      await fetch(url);
      return true;
    } catch {
      if (i < seconds * 2) await new Promise((r) => setTimeout(r, 500));
    }
  }
  return false;
}

/** F5 on a `.nuc` without a launch.json: the `dragonfly` debug type becomes the app's `dart` config. */
const dragonflyDebugProvider: vscode.DebugConfigurationProvider = {
  provideDebugConfigurations: () => [{ type: 'dragonfly', request: 'launch', name: 'Dragonfly app' }],
  resolveDebugConfiguration: async (_folder, config) => {
    const d = findDragonfly();
    if (!d) {
      void vscode.window.showWarningMessage('Not a Dragonfly project: run `dragonfly build` in the project first.');
      return undefined;
    }
    return dragonflyLaunch(d, { ...config, type: 'dart', request: 'launch' });
  },
};

/** Saving a `.nuc` of the project transpiles it and hot reloads the running app, like saving a `.dart`. */
async function reloadOnSave(doc: vscode.TextDocument): Promise<void> {
  if (doc.languageId !== 'nuclear') return;
  const d = dragonflyOf(doc.uri.fsPath) ?? findDragonfly();
  if (!d || !doc.uri.fsPath.startsWith(d.root + path.sep) || doc.uri.fsPath.startsWith(d.app + path.sep)) return;
  // a backend or web app reloads by itself on its build (Vite, uvicorn --reload, node --watch): build on every save
  if (d.launch.type !== 'dart') {
    if (vscode.workspace.getConfiguration('nuclear').get('buildOnSave', true)) await dragonflyBuild(d);
    return;
  }
  const session = vscode.debug.activeDebugSession;
  if (session?.type !== 'dart') return;
  const code = await dragonflyBuild(d);
  if (code === 0) await vscode.commands.executeCommand('flutter.hotReload');
  else if (code !== CODE_ERRORS) await repairAndRelaunch(session, 'the build failed');
}

// What a `dart` session of the project did: the Flutter debug adapter sends `flutter.appStarted` once the app
// runs; a disconnect/terminate from VS Code means the user stopped it.
interface SessionState {
  started: boolean;
  stopped: boolean;
  repairing: boolean;
}
const sessions = new Map<string, SessionState>();

function ofProject(session: vscode.DebugSession): Dragonfly | undefined {
  const d = findDragonfly();
  const cwd = session.configuration.cwd ?? session.workspaceFolder?.uri.fsPath;
  return d && cwd && path.resolve(cwd) === path.resolve(d.app) ? d : undefined;
}

// Flutter's own texts (flutter_tools: run_hot.dart, flutter_adapter.dart) and a Dart compile error.
const RELOAD_REJECTED = /Hot reload was rejected/;
const RELOAD_FAILED = /Failed to Hot (Reload|Restart)|\.dart:\d+:\d+: Error: /;

function watchSession(session: vscode.DebugSession): vscode.DebugAdapterTracker | undefined {
  if (!ofProject(session)) return undefined;
  const state: SessionState = { started: false, stopped: false, repairing: false };
  sessions.set(session.id, state);
  return {
    onWillReceiveMessage: (m: { command?: string }) => {
      if (m.command === 'disconnect' || m.command === 'terminate') state.stopped = true;
    },
    onDidSendMessage: (m: { type?: string; event?: string; body?: { output?: string } }) => {
      if (m.type !== 'event') return;
      if (m.event === 'flutter.appStarted') state.started = true;
      const text = m.event === 'output' ? (m.body?.output ?? '') : '';
      if (!state.started || !text) return;
      // a reload the VM cannot apply (e.g. a changed class shape) needs a restart; a compile error after a
      // clean transpile means stale generated code or packages
      if (RELOAD_REJECTED.test(text)) void vscode.commands.executeCommand('flutter.hotRestart');
      else if (RELOAD_FAILED.test(text)) void repairAndRelaunch(session, 'hot reload failed');
    },
  };
}

/** A session that ended before the app started, not stopped by the user: the launch failed (Gradle, Xcode,
 * pub, stale build). */
function sessionEnded(session: vscode.DebugSession): void {
  const state = sessions.get(session.id);
  sessions.delete(session.id);
  if (state && !state.started && !state.stopped) void repairAndRelaunch(session, 'the app did not start', true);
}

/** `dragonfly repair` and, if it worked, the same launch again. Once per launch: a relaunch that fails
 * again only reports it. */
async function repairAndRelaunch(session: vscode.DebugSession, why: string, ended = false): Promise<void> {
  const d = ofProject(session);
  const state = sessions.get(session.id);
  if (!d || state?.repairing) return;
  if (state) state.repairing = true;
  if (session.configuration.dragonflyRepaired) {
    await showBuildError(`${why} again after repairing the app (flutter clean included).`);
    return;
  }
  if (!(await dragonflyRepair(d, why))) {
    await showBuildError(`${why}; it still fails after flutter clean.`);
    if (state) state.repairing = false;
    return;
  }
  if (!ended) await vscode.debug.stopDebugging(session);
  const config: vscode.DebugConfiguration = { ...session.configuration, dragonflyRepaired: true };
  delete config.preLaunchTask; // already built by the repair
  await vscode.debug.startDebugging(session.workspaceFolder, config);
}

/** The Dart extension looks for Flutter apps when the window opens and ignores the ones created later
 * inside build/: when the first `dragonfly build` creates the app, a reload turns on devices and Run. */
function watchAppCreation(context: vscode.ExtensionContext): void {
  appAtStart = findDragonfly() !== undefined;
  const watcher = vscode.workspace.createFileSystemWatcher('**/build/*.code-workspace');
  const changed = async () => {
    updateRunContext();
    if (appAtStart || !findDragonfly()) return;
    appAtStart = true;
    const choice = await vscode.window.showInformationMessage(
      'Dragonfly: the Flutter app was created. Reload the window to enable devices, Run and hot reload.',
      'Reload Window',
    );
    if (choice) void vscode.commands.executeCommand('workbench.action.reloadWindow');
  };
  context.subscriptions.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed));
}

export async function deactivate(): Promise<void> {
  SettingsPanel.stopServices();
  await stopClient();
}

// ------------------------------------------------------------------ server

/** Finds the nuclear-lsp binary: setting → bundled with the extension → PATH → repository build. */
function findServer(context: vscode.ExtensionContext): string | undefined {
  const exe = process.platform === 'win32' ? 'nuclear-lsp.exe' : 'nuclear-lsp';
  const configured = vscode.workspace.getConfiguration('nuclear').get<string>('server.path');
  if (configured) {
    return configured;
  }
  const candidates = [
    context.asAbsolutePath(path.join('server', exe)),
    // development: the extension runs from editors/vscode inside the repository
    context.asAbsolutePath(path.join('..', 'target', 'release', exe)),
    context.asAbsolutePath(path.join('..', 'target', 'debug', exe)),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const c = path.join(dir, exe);
    if (dir && fs.existsSync(c)) {
      return c;
    }
  }
  return undefined;
}

async function startClient(context: vscode.ExtensionContext): Promise<void> {
  const command = findServer(context);
  if (!command) {
    const choice = await vscode.window.showErrorMessage(
      'Nuclear: the language server (nuclear-lsp) was not found. Build it with `cargo build --release -p nuclear-lsp` in the nuclear repository or set "nuclear.server.path".',
      'Open Settings',
    );
    if (choice) {
      vscode.commands.executeCommand('workbench.action.openSettings', 'nuclear.server.path');
    }
    return;
  }

  // dialects bundled with the extension (server/dialects) are found next to the binary by the server itself
  const serverOptions: ServerOptions = {
    run: { command, transport: TransportKind.stdio },
    debug: { command, transport: TransportKind.stdio },
  };

  const config = vscode.workspace.getConfiguration('nuclear');
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'nuclear' },
      { scheme: 'untitled', language: 'nuclear' },
    ],
    initializationOptions: {
      dialect: config.get<string>('dialect', 'flutter'),
      dialectPaths: config.get<string[]>('dialectPaths', []),
      codemetrics: config.get('codemetrics', {}),
    },
    synchronize: {
      configurationSection: 'nuclear',
      // dialects are data: editing one reloads it in the server without a restart
      fileEvents: vscode.workspace.createFileSystemWatcher('**/dialects/**/*.{toml,tpl}'),
    },
    outputChannelName: 'Nuclear Language Server',
  };

  client = new LanguageClient('nuclear', 'Nuclear Language Server', serverOptions, clientOptions);
  await client.start();
  metricsDecoration.reset();
}

/** The server stops five minutes after the last `.nuc` closes and starts again with the next one. */
function watchIdle(context: vscode.ExtensionContext): void {
  let timer: NodeJS.Timeout | undefined;
  const nucOpen = () => vscode.workspace.textDocuments.some((d) => d.languageId === 'nuclear');
  const check = () => {
    clearTimeout(timer);
    if (nucOpen()) {
      if (!client) void startClient(context);
      return;
    }
    timer = setTimeout(() => {
      if (!nucOpen()) void stopClient();
    }, 5 * 60_000);
  };
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidCloseTextDocument(check),
    { dispose: () => clearTimeout(timer) },
  );
  check();
}

async function stopClient(): Promise<void> {
  if (client) {
    const c = client;
    client = undefined;
    await c.stop();
  }
}

// ------------------------------------------------------------------ dialect

function updateStatus(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'nuclear') {
    statusItem.hide();
    return;
  }
  const card = editor.document.uri.scheme === 'file' ? projectCard(editor.document.uri.fsPath) : undefined;
  if (card) {
    statusItem.text = `$(symbol-namespace) ${card.platform ? `${card.platform} · ` : ''}${card.dialect}`;
    statusItem.tooltip = `Nuclear project ${card.name}: ${card.platform ?? card.language} platform, ${card.dialect} dialect (config.nuc)`;
    statusItem.command = undefined;
  } else {
    const dialect = vscode.workspace.getConfiguration('nuclear', editor.document.uri).get<string>('dialect', 'flutter');
    statusItem.text = `$(symbol-namespace) ${dialect}`;
    statusItem.tooltip = 'Nuclear dialect of files outside a project (click to change)';
    statusItem.command = 'nuclear.selectDialect';
  }
  statusItem.show();
}

async function selectDialect(): Promise<void> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'flutter', description: 'Dragonfly mobile: Flutter widgets, Dart output' },
      { label: 'fastapi', description: 'Dragonfly backend: FastAPI, Python output' },
      { label: 'nestjs', description: 'Dragonfly backend: NestJS, TypeScript output' },
      { label: 'react', description: 'Dragonfly web: React, TypeScript output' },
      { label: 'dart', description: 'Dart language only' },
      { label: 'python', description: 'Python language only' },
      { label: 'typescript', description: 'TypeScript language only' },
      { label: 'base', description: 'Base language only' },
    ],
    { placeHolder: 'Dialect used to check .nuc files' },
  );
  if (picked) {
    const target = vscode.workspace.workspaceFolders ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    await vscode.workspace.getConfiguration('nuclear').update('dialect', picked.label, target);
  }
}

// ------------------------------------------------------------------ generated code preview

interface TranspileResult {
  code: string;
  extension: string;
  dialect: string;
  errors: number;
}

const languageOfExtension: Record<string, string> = { dart: 'dart', ts: 'typescript', js: 'javascript' };

/** Read-only documents `nuclear-generated:/<path>.dart?<source uri>` with the transpiled code. */
class GeneratedCodeProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly open = new Map<string, vscode.Uri>(); // source uri → generated uri
  private timer: NodeJS.Timeout | undefined;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const source = vscode.Uri.parse(uri.query);
    if (!client) {
      return '// Nuclear: the language server is not running.';
    }
    try {
      const result = await client.sendRequest<TranspileResult>('nuclear/transpile', { textDocument: { uri: source.toString() } });
      if (!result.code) {
        return `// ${result.errors} error(s): fix them to see the generated ${result.dialect} code.`;
      }
      return result.code;
    } catch (e) {
      return `// Nuclear: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  track(source: vscode.Uri, generatedUri: vscode.Uri): void {
    this.open.set(source.toString(), generatedUri);
  }

  sourceChanged(doc: vscode.TextDocument): void {
    const target = this.open.get(doc.uri.toString());
    if (!target) {
      return;
    }
    clearTimeout(this.timer);
    // wait for the server to receive the change
    this.timer = setTimeout(() => this.emitter.fire(target), 300);
  }

  refreshAll(): void {
    for (const uri of this.open.values()) {
      this.emitter.fire(uri);
    }
  }
}

async function showGeneratedCode(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'nuclear') {
    return;
  }
  if (!client) {
    vscode.window.showWarningMessage('Nuclear: the language server is not running.');
    return;
  }
  const source = editor.document.uri;
  let ext = 'dart';
  try {
    const r = await client.sendRequest<TranspileResult>('nuclear/transpile', { textDocument: { uri: source.toString() } });
    ext = r.extension || ext;
  } catch (e) {
    vscode.window.showWarningMessage(`Nuclear: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const base = path.basename(source.path).replace(/\.nuc$/, '');
  const target = vscode.Uri.from({ scheme: GENERATED_SCHEME, path: `/${base}.${ext}`, query: source.toString() });
  generated.track(source, target);
  const doc = await vscode.workspace.openTextDocument(target);
  const language = languageOfExtension[ext];
  const shown = language ? await vscode.languages.setTextDocumentLanguage(doc, language) : doc;
  await vscode.window.showTextDocument(shown, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true, preview: false });
}

// ------------------------------------------------------------------ code metrics

/** One row of the details list of a code lens (computed by the server). */
interface MetricsDetail {
  label: string;
  description: string;
  line: number;
  character: number;
}

/**
 * Click on a "Complexity is N" code lens: lists every entry that adds complexity. Moving through the list
 * moves the cursor to the entry, like the original CodeMetrics extension.
 */
async function showCodeMetricsDetails(arg: { uri: string; items: MetricsDetail[] }): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!arg?.items) {
    return;
  }
  type Pick = vscode.QuickPickItem & { row: MetricsDetail };
  const picks: Pick[] = arg.items.map((row) => ({ label: row.label, description: row.description, row }));
  const jumpTo = (selected: unknown) => {
    const row = (selected as Pick | undefined)?.row;
    if (row && editor && editor.document.uri.toString() === arg.uri) {
      const start = new vscode.Position(row.line, row.character);
      editor.revealRange(new vscode.Range(start, start));
      editor.selection = new vscode.Selection(start, start);
    }
  };
  jumpTo(await vscode.window.showQuickPick(picks, { onDidSelectItem: jumpTo }));
}

interface MetricsMark {
  range: { start: { line: number; character: number } };
  complexity: number;
  level: 0 | 1 | 2 | 3;
  message: string;
}

interface MetricsAnswer {
  items: MetricsMark[];
  settings: {
    DecorationModeEnabled: boolean;
    OverviewRulerModeEnabled: boolean;
    DecorationTemplate: string;
    ComplexityColorLow: string;
    ComplexityColorNormal: string;
    ComplexityColorHigh: string;
    ComplexityColorExtreme: string;
  };
}

/**
 * The colored square at the end of the first line of every function / module with a code lens, and its mark on
 * the overview ruler (low, normal, high, extreme). Updated 500 ms after the last change, like the original.
 */
class CodeMetricsDecoration implements vscode.Disposable {
  private types: vscode.TextEditorDecorationType[] = [];
  private key = '';
  private timer: NodeJS.Timeout | undefined;
  private readonly subscriptions: vscode.Disposable[];

  constructor() {
    this.subscriptions = [
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) {
          this.schedule();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(0)),
    ];
  }

  /** Settings changed or the server restarted: recreate the decoration types. */
  reset(): void {
    this.key = '';
    this.schedule(300);
  }

  private schedule(delay = 500): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), delay);
  }

  private async update(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'nuclear' || !client) {
      return;
    }
    let answer: MetricsAnswer;
    try {
      answer = await client.sendRequest<MetricsAnswer>('nuclear/codeMetrics', {
        textDocument: { uri: editor.document.uri.toString() },
      });
    } catch {
      return;
    }
    const s = answer.settings;
    if (!s.DecorationModeEnabled && !s.OverviewRulerModeEnabled) {
      this.dispose(false);
      return;
    }
    const size = vscode.workspace.getConfiguration('editor', editor.document.uri).get<number>('fontSize', 14);
    const key = JSON.stringify([s, size]);
    if (key !== this.key) {
      this.dispose(false);
      this.key = key;
      const colors = [s.ComplexityColorLow, s.ComplexityColorNormal, s.ComplexityColorHigh, s.ComplexityColorExtreme];
      this.types = colors.map((color) => this.createType(s, color, size));
    }
    const byLevel: vscode.DecorationOptions[][] = [[], [], [], []];
    for (const item of answer.items) {
      const line = editor.document.lineAt(Math.min(item.range.start.line, editor.document.lineCount - 1));
      byLevel[item.level].push({ hoverMessage: item.message, range: new vscode.Range(line.range.end, line.range.end) });
    }
    this.types.forEach((type, level) => editor.setDecorations(type, byLevel[level]));
  }

  private createType(s: MetricsAnswer['settings'], color: string, size: number): vscode.TextEditorDecorationType {
    const options: vscode.DecorationRenderOptions = { rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed };
    if (s.OverviewRulerModeEnabled) {
      options.overviewRulerLane = vscode.OverviewRulerLane.Right;
      options.overviewRulerColor = color;
    }
    if (s.DecorationModeEnabled) {
      const vars: Record<string, string> = { color, size: String(size) };
      const svg = s.DecorationTemplate.replace(/\{\{(.+?)\}\}/g, (_, name: string) => vars[name] ?? '');
      options.before = {
        contentIconPath: vscode.Uri.parse('data:image/svg+xml,' + encodeURIComponent(svg)),
        margin: `${size / 2}px`,
      };
    }
    return vscode.window.createTextEditorDecorationType(options);
  }

  dispose(all = true): void {
    this.types.forEach((t) => t.dispose());
    this.types = [];
    this.key = '';
    if (all) {
      clearTimeout(this.timer);
      this.subscriptions.forEach((d) => d.dispose());
    }
  }
}
