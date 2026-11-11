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

## Other files

`syntaxes/nuclear.tmLanguage.json` (TextMate grammar, also used by JetBrains and the website copy);
`syntaxes/nuclear-example.tmLanguage.json` GENERATED (`comment.example.` scopes for `@example` code);
`language-configuration.json` (comments, pairs, `offSide` folding, `onEnterRules` for ` * `).
