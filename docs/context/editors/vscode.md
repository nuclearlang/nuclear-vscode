---
layer: L3
component: editors
read-when: you change the VS Code extension: Dragonfly projects, run/debug, save + hot reload, .nuc debugging, the Dragonfly device, process cleanup
---

# VS Code extension (`nuclear-vscode`)

## `src/extension.ts` — client and Dragonfly projects

Starts the server, status bar with the project's platform and dialect (from `.nuclear/project.json`, `projectCard`;
a file outside a project shows `nuclear.dialect` with the picker), view of generated code. Dragonfly projects
(`findDragonfly` reads `build/<name>.code-workspace`, also with only the folder open, `code .`):

- ▷ Run/Debug (`editor/title/run`, context `nuclear.canRun`) and F5 without launch.json (debugger `dragonfly` →
  config `dart`), both with `dragonfly build` first (queue `buildQueue`, panel *Dragonfly*).
- Ctrl+S on a `.nuc` → build + `flutter.hotReload` if there is a `dart` session; *Reload Window* is offered when
  the app appears with the window open (the Dart extension ignores new apps inside `build/`).
- Repair (only when something fails): build exit ≠ 0 and ≠ 2 → `dragonfly repair`; `watchSession`
  (DebugAdapterTracker of `dart`) marks `flutter.appStarted` and user stops, reads output (`Hot reload was
  rejected` → `flutter.hotRestart`; compile error → `repairAndRelaunch`); ended without starting and without
  Stop → repair + relaunch. Once per launch (`dragonflyRepaired`).
- `watchIdle`: stops the LSP 5 min after the last `.nuc` closes.

## `src/debug.ts` — debugging `.nuc` (ADR-0068, 0076; every dialect since 0.37)

Since 0.37 the same mirrors and paused-line display work for every dialect: the line map is
`<app>/.nuclear/lines.json` (written by every `nuclear build` of a project; `.dart_tool/nuclear_lines.json` for a
mobile app's `dragonfly build`), the tracker is registered for `DEBUG_TYPES` (dart, node, pwa-node, chrome,
pwa-chrome, msedge, debugpy, python), each `.nuc` breakpoint is mirrored with the project of its own file
(`find(dir)`), and the run-time error explanations stay Dart-only. `extension.ts` reads any `(debug)` launch of
`build/<name>.code-workspace` (the CLI writes debugpy for fastapi, node with source maps for nestjs, chrome for
react: `dragonfly/dragonfly/src/vscode.rs` `write_platform`); `runPlatformApp` builds and starts it (a react app's dev
server first, in its terminal); saving a `.nuc` of a backend or web project runs `dragonfly build`
(`nuclear.buildOnSave`), and the server or page reloads by itself.

Line map `build/app/.dart_tool/nuclear_lines.json` (`toDart`/`toNuc`): mirror breakpoints in the `.dart` (ids in
`mirrors`, places in `workspaceState` to delete those VS Code restores); `dart` tracker: `stopped` →
`stackTrace` → `.nuc` highlighted (`showPaused`, in the group left of the paused `.dart`); exception or error
block in `output` → `dragonfly explain --json` → diagnostic `dragonfly-runtime` + webview *Nuclear: runtime
error*. `built()` after each build. Settings `nuclear.debug.followInNuclear` / `explainErrors`. Mixed debugging:
`nucStep` (F10/F11/Shift+F11 when `nuclear.pausedInNuc && (editorLangId == nuclear || nuclear.nucStepping)`;
repeats `next`/`stepIn` while the `.nuc` line and stack depth do not change, cap 200), `showValues`, `hover`
(`EvaluatableExpressionProvider`), view `nuclear.callStack`, `nuclear.debug.otherSide`, `openPlace`.
Untested with a device.

## `src/device.ts` — Dragonfly device (ADR-0074; several at once since 0.33, ADR-0099)

Several devices: `panels` (a `Set<DevicePanel>`, each with its own `running`, `lastView` and `id`), the launch config carries `dragonflyPanel` (the panel to run on: `nuclear.runOnDevice(panelId?, root?)`; without it `DevicePanel.idle()`, a free panel, or a new one: a running device is never replaced), `parked` + `DevicePanel.park()`/`unpark()` (`nuclear.parkDevices`/`unparkDevices`, called by `Workspace.switchTabs`: `switchTabs` parks on every workspace switch and unparks after reopening the code, so a device always gets a fresh locked editor group beside the code (the right, like Android Studio) and is never merged into the code's group; parked apps keep running and get panels again in a mobile workspace or the Devices tool; a parked app whose session ends is cleaned by `endRunning`), `Running` lives on its own (`panel` optional, `title`, `lastUsed`, `ended`; `alive()` = panels' apps + `parked`): a disposed panel parks its app, `endRunning` ends one (session, cdp, browser, `reap`), `closeDevice(id)` (`nuclear.closeDevice`, the pane's ✕), `revealDevice` adopts a hidden one (`hidden:<key>` ids), `watchdog()` every `WATCH_MS` (idle `IDLE_LIMIT` → end; `pgrep -af` by marker → `reap` of keys no app owns), `freeNumber()` titles, the launch config `name` = the device's title, `nuclear.runOnDevice(panelId, root, noDebug)`; `Workspace.pickDevice(p, mode)` (▷ Run / ◉ Debug / ▭ Device: devices shown or hidden, new, *Other Flutter device…* via `flutter.selectDevice`, or the Devices workspace), `Workspace.mobileRoot` (the Devices pane runs a mobile project only), `watchSessions` finds the panel by `running.key`, `DevicePanel.show(context, preset?)` always opens one more (title `Dragonfly device N`, a `preset` message selects the device), `devices()`/`devicesChanged`/`revealDevice` feed the workspace. `findDragonfly(root?)` / `runApp(noDebug, deviceId, extra, root)` in `extension.ts` take the project's root (a tab of the workspace), `dragonflyOf(file)` walks up for the hot reload on save. Then, per panel:

Flutter custom device `dragonfly` only for VS Code (`ensureDevice`: `dragonfly flutter custom-devices add --json`
with `FLUTTER_CUSTOM_DEVICES=true`; adds to the user's `dart.env` `FLUTTER_CUSTOM_DEVICES=true` and
`CHROME_EXECUTABLE` if needed; `_dart.reloadExtension`; a `configurationDefaults` of `dart.env` does NOT reach the
Dart extension). `launchProvider` (`resolveDebugConfiguration` of `dart`; a `-d` in `toolArgs` does NOT work):
`deviceId: 'chrome'` + `--web-port`, `--web-browser-debug-port`, `--web-browser-flag=--headless=new`,
`--enable-unsafe-swiftshader`, `--web-launch-url http://127.0.0.1:<port>/assets/__dragonfly_device__` (an empty
404; `about:blank` does not work). `attach` (own CDP over Node 24's WebSocket): `emulate` (metrics, touch, user
agent; first time `Page.navigate` already emulated, later `Page.reload` only if the platform changes),
`Page.startScreencast` (also on `Page.loadEventFired`) at `r.density` = the physical pixels the panel shows the screen at (the webview reports `shot` = CSS width × zoom × `devicePixelRatio` in the `size` message; `sized` sets `density = max(dpr, shot / width)` capped at 4 and only ever raises it, re-emulating), falling back to `captureScale(p)` before the first measurement; jpeg 100. So a frame matches the device's on-screen pixels 1:1 and nothing is upscaled (the old 2x cap, and even full-`dpr`, blurred phones zoomed on a HiDPI screen). `closeBrowser` at the end; input via
`Input.dispatchTouchEvent`/`MouseEvent`/`KeyEvent`. Reconnects (`cdp.onclose`, 10 tries); re-emulates when a
frame's size differs (every 2 s at most). Panel width saved per screen width (`nuclear.device.widths`, default
20 % between 340 and 540). *Fit* up to zoom 1.5. `lockDeviceGroup`. `web-server` rejected (no breakpoints).

## `src/webDevice.ts`, `src/webSession.ts`, `src/cdp.ts` — the web device (0.37)

The web platform's device: ▭ Device / ◉ Debug / ↻ Reload of a web project (`nuclear.webDevice.{open,debug,reload}`, one
panel per project, beside the code). `webSession.ts` has no VS Code: it runs the app's Vite (`build/app/node_modules/
.bin/vite`, free port, `127.0.0.1`) and a headless Chromium (`browserExecutable()`: `CHROME_EXECUTABLE`, Chrome,
Chromium, Brave, Edge, Vivaldi) with its own profile, drives the page over CDP (`cdp.ts`, shared with `device.ts`):
`Emulation.setDeviceMetricsOverride` / touch / user agent per `WEB_PRESETS` (desktop, laptops, tablets, phones),
`setEmulatedMedia` (`prefers-color-scheme`), `Network.emulateNetworkConditions` (`THROTTLES`), `setCacheDisabled`,
the screencast at the panel's density (zoom × devicePixelRatio), input (mouse on desktop presets, touch otherwise),
history, `captureScreenshot`, the DevTools frontend url; it reports `Runtime.consoleAPICalled`, `exceptionThrown`,
`Log.entryAdded` and the `Network.*` events. `webDevice.ts` is the panel (address bar, device bar, Console / Network
dock) and its commands; ◉ Debug starts a `chrome` attach session on the device's CDP port with `webRoot` = the app, so
`debug.ts` mirrors `.nuc` breakpoints into the generated `.ts`. It can be tested without VS Code: bundle a script that
imports `webSession.ts` with esbuild and run it with node against a built app (done 2026-11-10 against the website).

## Processes (0.27)

Nothing stays alive when VS Code closes: `marker(key)` = `__dragonfly_device_<extension host pid>_<key>__` in
`--web-launch-url`; `reap(mark, wait?)` (detached sh: waits for `wait` to die, `pkill -TERM -f`, 3 s, `-KILL`; no
Windows version) runs on activate and in `closeRunning`. A relaunch from `repairAndRelaunch` is a new launch
(`dragonflyToolArgs`). Panel closed 5 min → `stopDebugging` (except `external`).

## `src/http.ts`, `src/httpPanel.ts` — Nuclear HTTP (0.29, ADR-0098; a workspace since 0.33, ADR-0099)

`HttpModel` (`activateHttp(context)` returns it): `findProjects` walks the workspace folders (depth 4, skipping
build/node_modules/...) for `.nuclear/project.json` and reads `.nuclear/contract.json` next to it (written by
`project::write_metadata`, so the LSP's `Project::build` produces it); `tree()` gives `TreeNode`s (platform → project →
Contracts [↓ update buttons] / component → endpoint; "OpenAPI documents" [+] from the active environment's `openapi`
list, grouped by tag) that the workspace webview draws; environments in `<first workspace folder>/.nuclear/http.json`
(else `globalStorageUri/http.json`; `active`, `environments.<name>.{vars, headers, baseUrls, openapi}`; `{{var}}`
resolved by the extension host). Commands `nuclear.http.{refresh,selectEnvironment,editEnvironments,addOpenApi,open}`
and `nuclear.contracts.update (root?, name?)` (runs `~/.local/bin/nuclear contracts update` in the project, output
channel *Nuclear HTTP*). `ComponentPanel` (`httpPanel.ts`): one webview panel per `componentKey(endpoint)`
(`project::component`), with an inner tab per endpoint (method, url, path/query params, headers, body with a sample
from the contract's model, send with `fetch` and a 30 s timeout, response pretty-printed, copy as curl); the webview
posts its whole state (`tabs`, `active`) on every change and the model keeps it in `memory` by key, so `restore(keys)`
rebuilds the panels when the HTTP workspace is entered again (`model.reopen` = the keys open when it was left).
Watches `**/.nuclear/*.json`. Verbs and sections use theme colors contributed by the extension (`colors` in
package.json: `nuclearHttp.get/post/put/patch/delete/platform/project/component`, dark and light defaults; a theme
may override them; CSS `var(--vscode-nuclearHttp-get)`). The container icon is `icons/nuclear.svg`, the trefoil glyph
as a `currentColor` mask generated by `theme/icons.mjs` (the activity bar paints every icon in the theme's color: a
colored logo is not possible there). Not run in a VS Code window yet.

## `src/workspace.ts` — the Nuclear workspace (0.31–0.33, ADR-0099)

Container `nuclear` (activity bar) = webview view `nuclear.workspace` (`Workspace`, a `WebviewViewProvider`,
`retainContextWhenHidden`), the only view. The webview draws the strip (project tabs with the platform glyph
`icons/platform-<platform>.svg` + the dialect's Atom Material icon as a badge (`DIALECT_ICONS`) and their number, `+`,
the `TOOLS` at the bottom) beside a pane that depends on the active tab (`activeKey()`: a project root or
`tool:<id>`, `workspaceState` `nuclear.workspace.active`; `LAST_PROJECT` is the project the tools act on):

- a project: its files; `PLATFORM_ACTIONS[platform]` are the `editor/title` buttons of `package.json` (commands `nuclear.action.<id>`, shown by the context key `nuclear.platform` that `refresh()` sets; `action(id)`; a mobile run/debug/device of a root outside the workspace folders saves `PendingAction` in global state, adds the folder and reloads; `activateWorkspace` resumes it: mobile run/debug → `nuclear.run`/`nuclear.debug`
  with the root, reload → `flutter.hotReload`, device → `nuclear.runOnDevice(undefined, root)`, api → the HTTP tool;
  the rest in a terminal named `<project> · <action>` with `TERMINAL_COMMANDS`), then the file tree (lazy `list` →
  `entries`; `Icons.entriesOf` skips `.git` and plain `files.exclude` names, folders first, each entry with its icon
  of the Chernobyl icon theme — `icon-themes/<slug>-icon-theme.json`, the user's variant: `fileNames` → longest
  `fileExtensions` → `file`; `folderNames[Expanded]` → `folder[Expanded]`; webview uris, `localResourceRoots` icons +
  icon-themes; `open` → `vscode.open`; a `FileSystemWatcher` on the root posts `refreshDir`);
- `tool:http`: the env bar (change / edit / ↻) and `HttpModel.tree()` drawn with chevrons, inline `GLYPHS` and the
  `nuclearHttp.*` colors (collapsed ids kept in the webview); an endpoint → `nuclear.http.open`, a node button →
  `updateContracts` / `addOpenApi`;
- `tool:devices`: `devices()` of `device.ts` (title, status dot) with *▷ run* (`nuclear.runOnDevice(id, root)`) and
  *+ New device* (a `PRESETS` quick pick → `nuclear.openDevice(preset)`);
- the other tools: a template line; `ToolPanel` opens their page.

Projects = `findProjects()` (workspace folders) + the roots saved in `globalState` `nuclear.workspace.projects`
(opened with `openProject`, read by `projectAt`: the card, else `config.nuc`/`nuclear.toml` by regex). `go(key)` calls
`switchTabs(from, to)`: the open `TabInputText` tabs of the tab left go to `workspaceState` `nuclear.workspace.tabs`
(path, column, active), every tab but the device webviews (`viewType` ends with `dragonflyDevice`) is closed
(`tabGroups.close`; a kept dirty editor cancels), and the entered tab's editors come back (text files, or
`ComponentPanel.restore` for HTTP, or the template page). Clicking a tab or an action posts a toast with its shortcut.
Commands `nuclear.workspace.{show,project,openProject,tool,action,welcome,addToVsCode}` (project/tool/action without
arguments show a quick pick); keybindings in package.json (`ctrl+1..9`, `ctrl+alt+n/o/w`, tools `ctrl+alt+h/v/d/m/a/s`,
actions `ctrl+alt+r/g/l/b/t/c` on `nuclear.action.*`, `serve` on `ctrl+alt+r` for backend/web). `WelcomePanel` (singleton, column one; re-rendered on
`Workspace.onDidChange`; opened on activation when `nuclear.workspace.welcome` and every tab group is empty;
`onStartupFinished` activation). Not run in a VS Code window yet.

## `src/aiSetup.ts`, `src/aiSetup.json`, `src/setupPanel.ts` — the set-up of the AI services (ADR-0106)

- `aiSetup.ts` has no editor in it: `nuclear-loop setup` (`loopCli.ts`) and the wizard are its two fronts. It reads
  the machine (`hardware`), says how a profile sits on it (`fit`, `recommend`), finds what is installed
  (`requirements`, `status`), and gives the ordered `steps(profile, root)`: the graph's tool (`uv tool install`,
  editable when the folder is a git checkout), the Developer (`dragonfly install` with a Python 3.12+ that uv finds
  or brings, and the `nuclear-developer` launcher), the models (Ollama's `/api/pull`, with its progress), the graph's
  service, the knowledge base (`connect` twice, `ingest`), the Developer's service. Every step can run again.
- `aiSetup.json` is the data: the requirements (their command, their installer per system, their page) and the
  profiles (models, download, memory, what works, what does not). Changing a profile is changing this file and
  measuring it (`nuclear-developer/eval/run.py`); `test/setup.test.ts` holds its shape.
- The machine's choice is `machineFile()` (`~/.config/nuclearlang/ai.env`): `readMachine` gives the Loop
  (`defaultConfig`) and the editor (`aiSettings`) their default models; a model set in the editor's settings wins and
  is written there when the settings page restarts a service.
- `serviceFiles(platform)` are the files that start the services at login (systemd user units, launch agents, a
  Startup script); `restartService` goes through the system's manager, and the settings page uses it before starting
  a process of its own. `remove()` is `nuclear-loop setup --remove`.
- `setupPanel.ts` is the page: four steps drawn from one state message; it polls `check` every three seconds on the
  requirements step; an installer runs in a terminal (`createTerminal` + `sendText`), never hidden.
  `SetupPanel.offer` asks once on a machine with no machine file.
- The services' folder is `aiRoot()`: `<installation>/ai`, or `NUCLEAR_AI_ROOT`.

## `src/settingsPanel.ts`, `src/aiSettings.ts`, `src/localModels.ts` — Settings and integrations (ADR-0102 §18)

The tool `settings` (`Ctrl+Alt+S`). `aiSettings()` reads `nuclear.ai.*` (package.json `contributes.configuration`);
`machineConfig()` is passed to `readConfig(root, platform, machine)` (defaults < settings < the project's
`.nuclear/loop.json`); `serviceEnv()` is the environment the graph and the Developer are started with (`CODER_MODEL`,
`ASSISTANT_MODEL`, `OLLAMA_URL`, `NUCLEAR_GRAPH_EMBED`, ports). The page: services (health urls; *Start*/*Restart*
spawns `nuclear-graph serve` / `nuclear-developer`, owned processes stopped on deactivate), models (Ollama
`/api/tags`, `billionsOf` with the effective size of `eNb` tags, `MAX_BILLIONS` 3.5, *Pull* as a task), MCP (`claude
mcp get|add --scope user`, `codex mcp list|add`, `~/.cursor/mcp.json` merged), connections (`nuclear-graph
requests|allow|deny|revoke|connect mcp`, Jira in the secret storage via `jiraAuth`, `gh auth status`), pipeline.

## `src/loopSafety.ts`, `src/connections.ts` — fail-safe runs and checked connections (ADR-0102 §§21–22)

`loopSafety.ts` (no VS Code import): `atomicWrite`, `trace`/`readTrace` (JSON lines), `owner`/`alive`/`orphaned`
(`BEAT_MS` 10 s, `STALE_MS` 45 s), `rollback` of the ledger (`Run.writes`), `checkConnections` (services, models,
tools' `--version`, `freeMb`), `ollamaBusy` (`/api/ps`). In `loopEngine.ts`: `start` refuses a run another live
process owns, recovers an orphaned one, beats, runs `preflight` before the first stage it runs; `writeFile` keeps the
ledger; `watched` cuts a call (`StallError`) on `callTimeoutMs` or `stallSeconds` without the Developer or a model;
commands get `commandTimeoutMs` (`TIMED_OUT`, the process group killed); `recoverRun`/`recoverRuns`. In loopPanel.ts:
`driveRun` (module-level), `resumeOrphans` (activation). `connections.ts`: `checkAll` (also Codex, OpenCode, GitHub,
Jira), `checkForChat`, `watchConnections` (every `checkEveryMinutes`, a notice of kind `settings` on a change).

## `src/notifications.ts` — notifications of the local agents (ADR-0102 §19)

`notices` (one store): `add` (a toast with *Open* unless the tool is on screen), `watch(tool, visible)` from the panels'
`onDidChangeViewState`, `unread(tool)`, `open` (set by the workspace: `openNotice` → the tool on the run / session).
The workspace sets `WebviewView.badge` (the Nuclear icon in the activity bar), a count on each tool's tab and the list
in the tool's pane. The Loop's engines (`engines` in loopPanel.ts) and the chat's jobs (`jobs` in chatPanel.ts) are
module-level: a page is only a view, so closing it or switching tools leaves the work running.

## `src/chatPanel.ts` — the Nuclear agent tool (ADR-0102 §16)

The tool `agent` of the strip (`Ctrl+Alt+A`): a chat with the local agents. A message goes to `POST
/developer/chat` (`message`, `platform`, `map` = `.nuclear/map.md` clipped to 12 000 characters, `history` = the last
8 messages, `historyOf`); `/task <text>` builds a local-led `Spec` (`criteriaOf`) and runs a `LoopEngine` in place,
drawing each step as it ends and answering with the run's `notes` and its journal. Sessions: `.nuclear/chat/<id>.json`
(`listSessions`, `saveSession`; a job is `ask` or `drive`, saved by `append` even with the page closed). Each answer keeps
`steps`, `seconds`, `tokens` (the assistant's `context` trace, `tokensOf` = characters / 4), drawn folded in grey; the
context meter (`nuclear.ai.contextTokens`); `askedOf` for ↑ / ↓; *↻ Retry* of a failed question (`ask` message) or of a
failed order from its failed step. Templates: `templatesOf(map, platform)` from the map's components, use cases and
controllers/screens. The page renders the answers' markdown itself (code blocks, inline code, bold, lists).

## `src/loopEngine.ts`, `src/loopPanel.ts` — the Loop tool (ADR-0102)

A tool of the workspace strip (`Ctrl+Alt+P`, id `loop`), one full-screen webview like Devices and HTTP.
`loopEngine.ts` has no VS Code import (a node script drives it; `npm test` runs `test/loop.test.ts` with node:test):
retries (`backoff`: exponential with full jitter, capped, `Retry-After` wins; `transientStatus`; `config.retry`),
`start(from?, step?)` runs a run again: from its first failed stage, from a stage (`from`), or from one step by its
id (`step`: it and every step after it; the ones before it are kept), `restart()` from scratch; `guard()` refuses a
run that is running, `undo()` puts back what the steps left out wrote (`loopSafety.rollback`: a file whose `digest`
is not the one the write left is kept and named), `forget()` moves them to `run.previous` with the reason, `planKept()`
keeps the pieces the user wrote and drops the planner's; `upgradeRun()` gives a run of an older `ENGINE` today's
stages and makes its next retry a restart; `decide()` records a step's `decisions` (`Decision`: what, why); `accept()`
asks `/developer/accept` after a passing verification (`Run.acceptance`, never a gate); `restoreWritten`
reads the files back, `diagnose()` asks `/developer/diagnose` when a stage fails (`run.diagnosis`); `Spec`, `Run`, `Stage`, `Step` (each with an
`Actor`: you, claude, planner, coder, tester, security, shell, graph), `LoopEngine.start()` runs spec → generate →
plan → tests first → code → verify → security → artifacts → deploy (generate, ADR-0103: `specResources` — the spec's
`## Resources` or its `GET <url>` lines — through `dragonfly gen resource ... --from-spec`, the changed files found by
`nucFiles` snapshots and put in the write ledger, `Step.files`; the planner gets `generatedNote()` and
`withoutGenerated` drops a piece that repeats one; the strategy of the request, ADR-0105: `analyze()` is the last
step of the spec stage and asks `/developer/analyze`, `Run.analysis` — its `stages` skip the others in `stages()`, its
`generate` calls join the spec's in `generateStage` through `gen()`, its `pieces` are the plan when the tools gave them
and a piece with `code` is written as it is, `wire()` runs `dragonfly gen usecase` for each use case the coder wrote,
`verifyStage` repairs the file a failure names for `mode: fix`, never a test; `Spec.strategy` is the spec's `- Strategy:`
line) and saves `.nuclear/loop/runs/<id>.json` on every step (`change` event);
`specs/<id>/spec.md` is written by the spec stage. Agents: the Nuclear Developer over HTTP (`developerUrl`), Claude
through `claude -p --output-format stream-json` with the Nuclear MCP (`graphCommand mcp`, `--strict-mcp-config`,
`--tools` limited to the stage's built-ins): every tool call is a step, `developer_*` calls drawn as the local agent.
Code stage: each piece by the coder (Claude takes the ones it leaves with errors and keeps the fix as a graph
example), then `commands.check`; a project error gets one local repair per file (`repairProject`), then Claude.
Commands are data: `.nuclear/loop.json` (`defaultConfig(platform)`), exported by `ciFile()` to GitHub Actions, GitLab
CI or Bitbucket Pipelines (the deterministic stages). Sources: `jiraIssue`/`jiraMine` (REST v3, ADF to text; the
site, email and API token in VS Code secret storage `nuclear.loop.jira`), `githubIssue` (`gh issue view`);
`criteriaOf` reads the list under "Acceptance criteria". `suggestContext` ranks the project's and the user's `.md`
(agent instructions first, then specs, context, ADRs, skills, agent definitions) by the words of the spec.
`loopPanel.ts` draws it: the runs, the spec form (use case → spec written or imported → context → who leads, with an
optional plan preview by the local planner), and a run as a graph: a column per stage, a node per step in the order it ran, the
steps its agent followed as nodes under it, edges between them; a click on a node opens a drawer beside the graph
(*What it did*, its decisions, input, output, code) with *Run again from this step*; each stage has *Run <stage>
again* and the run *Run again from scratch* (a modal confirmation: it undoes files). The messages are `retry`,
`retryStep`, `retryStage`, `scratch`.

`src/loopCli.ts` is `nuclear-loop` (`npm run loop` → `out/nuclear-loop.js`, also part of `compile`; `stage.sh` puts
it in the installation's `bin/` with a `node` wrapper): `run [spec.md] [--lead]` (`parseSpecMarkdown`, the inverse of
`specMarkdown`; no file = the spec changed last; the project is the closest folder up with `config.nuc`), `retry <run> [--from <stage> | --step <id>]`, `restart <run>`, `ci
[stage...]` (`ciCommands`, the same grouping `ciFile` exports), `export <provider>`, `runs`. The JetBrains tool window
drives the Loop through it (no Zed: the Loop is for VS Code and Android Studio only, decided by the user).

## Other files

`syntaxes/nuclear.tmLanguage.json` (TextMate grammar, also used by JetBrains and the website copy);
`syntaxes/nuclear-example.tmLanguage.json` GENERATED (`comment.example.` scopes for `@example` code);
`language-configuration.json` (comments, pairs, `offSide` folding, `onEnterRules` for ` * `).
