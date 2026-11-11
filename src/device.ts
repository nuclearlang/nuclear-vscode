// "Dragonfly device": the app running inside VS Code, like Android Studio's Running Devices.
//
// - Only VS Code lists it: a Flutter custom device (id `dragonfly`) that the extension registers by itself. Custom
//   devices are on only where `FLUTTER_CUSTOM_DEVICES=true`: the extension adds it to the user's `dart.env` (the Dart
//   extension passes it to its Flutter processes); `flutter devices` in a terminal and other IDEs do not show it.
//   (A `configurationDefaults` value for `dart.env` does not reach the Dart extension, so it is written.)
// - Launching on it runs the app on Flutter's `chrome` device with a headless Chromium (Chrome, Chromium, Brave,
//   Edge...): Flutter debugs it like any web app (breakpoints, hot reload, hot restart). Flutter's `web-server`
//   device cannot stop at breakpoints (its WebSocket debug service has no breakpoints).
// - Like Android Studio's emulator view, the panel shows the browser's screen (CDP `Page.startScreencast`) and sends
//   the user's taps, clicks, wheel and keys back (CDP `Input.*`). The device is Chrome's device mode (metrics,
//   user agent, touch): Flutter then behaves as on iOS or Android, and every input lands where it is drawn.

import { browserPage, Cdp, freePort } from './cdp';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const DEVICE_ID = 'dragonfly';
const DEVICE_LABEL = 'Dragonfly device';
const STATE_KEY = 'nuclear.device.view';
const WIDTHS_KEY = 'nuclear.device.widths'; // panel width the user left, per screen width
// first width of the panel: a share of the screen, between a laptop's and about a real phone on a 4K screen
const MIN_WIDTH = 340;
const MAX_WIDTH = 540;
const defaultWidth = (screen: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(screen * 0.2)));
const HOST = '127.0.0.1';
const IDLE_LIMIT = 30 * 60_000; // a device nobody looks at (hidden or not visible) this long is stopped
const WATCH_MS = 60_000; // the watchdog: idle devices and orphan processes

/** In the launch URL, so Flutter's `run` and its browser carry it in their command line (see `reap`). */
const marker = (key: string) => `__dragonfly_device_${process.pid}_${key}__`;

/** Ends the processes whose command line has `mark`: TERM (Flutter's `run` closes its browser and DDS), KILL
 * 3 s later. With `wait` (a pid), first waits until that process is gone. Runs detached: it outlives VS Code.
 * shortcut: Unix only (pkill); add a taskkill version if the device is used on Windows. */
function reap(mark: string, wait?: number): void {
  if (process.platform === 'win32') return;
  // the mark goes in two pieces so this shell's own command line never matches it
  const script = 'while [ -n "$3" ] && kill -0 "$3" 2>/dev/null; do sleep 2; done; pkill -TERM -f "$1$2"; sleep 3; pkill -KILL -f "$1$2"';
  spawn('sh', ['-c', script, 'sh', mark.slice(0, 8), mark.slice(8), wait ? String(wait) : ''], { detached: true, stdio: 'ignore' }).unref();
}

// ------------------------------------------------------------------ Flutter custom device

/** The custom device entry: Flutter only lists it; launches on it are turned into `chrome` launches. */
function customDevice(): object {
  const win = process.platform === 'win32';
  const ok = win ? ['cmd', '/c', 'exit 0'] : ['true'];
  const refuse = win
    ? ['cmd', '/c', 'echo Dragonfly device: run the app from VS Code (NuclearLang extension) & exit 1']
    : ['sh', '-c', 'echo "Dragonfly device: run the app from VS Code (NuclearLang extension)" >&2; exit 1'];
  return {
    id: DEVICE_ID,
    label: DEVICE_LABEL,
    sdkNameAndVersion: 'Flutter web inside VS Code',
    enabled: true,
    platform: 'linux-x64',
    ping: ok,
    install: ok,
    uninstall: ok,
    runDebug: refuse,
  };
}

function run(cmd: string, args: string[], cwd: string, env: Record<string, string>): Promise<{ ok: boolean; out: string }> {
  return new Promise((done) =>
    execFile(cmd, args, { cwd, env: { ...process.env, ...env, NO_COLOR: '1' } }, (err, stdout, stderr) =>
      done({ ok: !err, out: stdout + stderr }),
    ),
  );
}

const isFile = (f: string) => {
  try {
    return fs.statSync(f).isFile();
  } catch {
    return false;
  }
};

/** A Chromium browser for Flutter's `chrome` device when Flutter would not find one by itself (it looks only for
 * Google Chrome): Chromium, Brave, Edge, Vivaldi. Undefined when Flutter finds Chrome or none is installed. */
function chromium(): string | undefined {
  if (process.env.CHROME_EXECUTABLE) return undefined;
  const onPath = (names: string[]) =>
    names.flatMap((n) => (process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, n))).find(isFile);
  if (process.platform === 'linux') {
    if (onPath(['google-chrome'])) return undefined;
    return onPath(['google-chrome-stable', 'chromium', 'chromium-browser', 'brave', 'brave-browser', 'microsoft-edge', 'microsoft-edge-stable', 'vivaldi']);
  }
  if (process.platform === 'darwin') {
    if (isFile('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) return undefined;
    return ['Chromium.app/Contents/MacOS/Chromium', 'Brave Browser.app/Contents/MacOS/Brave Browser', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      .map((a) => `/Applications/${a}`)
      .find(isFile);
  }
  const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean) as string[];
  if (roots.some((r) => isFile(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')))) return undefined;
  return roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')).find(isFile);
}

/** Registers the device and sets VS Code's Flutter environment (once, silently): custom devices on, and the
 * browser of the `chrome` device when Flutter would not find it. */
async function ensureDevice(p: Project): Promise<void> {
  let changed = false;
  const dart = vscode.workspace.getConfiguration('dart');
  const want: Record<string, string> = { FLUTTER_CUSTOM_DEVICES: 'true' };
  const browser = chromium();
  if (browser) want.CHROME_EXECUTABLE = browser;
  const env = dart.get<Record<string, string>>('env', {});
  if (Object.entries(want).some(([k, v]) => env[k] !== v && !(k === 'CHROME_EXECUTABLE' && env[k]))) {
    const user = (dart.inspect<Record<string, string>>('env')?.globalValue ?? {}) as Record<string, string>;
    await dart.update('env', { ...want, ...user, FLUTTER_CUSTOM_DEVICES: 'true' }, vscode.ConfigurationTarget.Global);
    changed = true;
  }
  // 0.20.x showed the `web-server` device; the `chrome` device replaced it
  if (dart.inspect('flutterShowWebServerDevice')?.globalValue === 'always') {
    await dart.update('flutterShowWebServerDevice', undefined, vscode.ConfigurationTarget.Global);
    changed = true;
  }
  const flutterEnv = { ...p.env, FLUTTER_CUSTOM_DEVICES: 'true' };
  const list = await run(p.dragonfly, ['flutter', 'custom-devices', 'list'], p.root, flutterEnv);
  if (!list.out.includes(DEVICE_LABEL)) {
    const add = await run(p.dragonfly, ['flutter', 'custom-devices', 'add', `--json=${JSON.stringify(customDevice())}`], p.root, flutterEnv);
    if (!add.ok) {
      void vscode.window.showWarningMessage(`Dragonfly: could not add "Dragonfly device": ${add.out.trim().split('\n').pop()}`);
      return;
    }
    changed = true;
  }
  if (!changed) return;
  // the Dart extension's Flutter daemon reads the env and the devices when it starts: restart it (the Dart
  // extension's own silent restart), or ask for a window reload if that command is gone
  try {
    await vscode.commands.executeCommand('_dart.reloadExtension', 'dragonfly-device');
  } catch {
    const choice = await vscode.window.showInformationMessage(
      'Dragonfly: "Dragonfly device" is ready. Reload the window to see it in the device picker.',
      'Reload Window',
    );
    if (choice) void vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
}

// ------------------------------------------------------------------ device presets

export interface Preset {
  name: string;
  width: number;
  height: number;
  dpr: number;
  os: 'ios' | 'android' | 'web';
  frame: 'phone' | 'tablet' | 'none';
}

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// The sizes of the browsers' device toolbar (CSS pixels, portrait).
export const PRESETS: Preset[] = [
  { name: 'Responsive', width: 400, height: 800, dpr: 1, os: 'web', frame: 'none' },
  { name: 'iPhone SE', width: 375, height: 667, dpr: 2, os: 'ios', frame: 'phone' },
  { name: 'iPhone 14 Pro', width: 393, height: 852, dpr: 3, os: 'ios', frame: 'phone' },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932, dpr: 3, os: 'ios', frame: 'phone' },
  { name: 'Pixel 7', width: 412, height: 915, dpr: 2.625, os: 'android', frame: 'phone' },
  { name: 'Samsung Galaxy S20 Ultra', width: 412, height: 915, dpr: 3.5, os: 'android', frame: 'phone' },
  { name: 'Samsung Galaxy A51/71', width: 412, height: 914, dpr: 2.625, os: 'android', frame: 'phone' },
  { name: 'iPad Mini', width: 768, height: 1024, dpr: 2, os: 'ios', frame: 'tablet' },
  { name: 'iPad Air', width: 820, height: 1180, dpr: 2, os: 'ios', frame: 'tablet' },
  { name: 'iPad Pro', width: 1024, height: 1366, dpr: 2, os: 'ios', frame: 'tablet' },
  { name: 'Galaxy Tab S7', width: 800, height: 1280, dpr: 2, os: 'android', frame: 'tablet' },
  { name: 'Laptop', width: 1280, height: 800, dpr: 1, os: 'web', frame: 'none' },
  { name: 'Desktop', width: 1920, height: 1080, dpr: 1, os: 'web', frame: 'none' },
];

/** The browser identity of a preset: user agent and platform (none for web: the browser's own). */
function identity(p: Preset): { ua?: string; platform?: string } {
  if (p.os === 'web') return {};
  if (p.os === 'android') return { ua: ANDROID_UA, platform: 'Linux armv8l' };
  return p.frame === 'tablet' ? { ua: IPAD_UA, platform: 'iPad' } : { ua: IOS_UA, platform: 'iPhone' };
}

/** What the panel shows: the device and its size (CSS pixels, rotation applied). */
interface View {
  preset: string;
  width: number;
  height: number;
  landscape: boolean;
}

// ------------------------------------------------------------------ Chrome DevTools Protocol

// ------------------------------------------------------------------ launches on the device

export interface Project {
  root: string;
  app: string;
  dragonfly: string;
  env: Record<string, string>;
}

/** An app running on a device. It lives on its own: closing the panel only hides it (the app goes on with its
 * session); the Devices workspace, the watchdog or the end of its session stop it. */
interface Running {
  key: string; // dragonflyDevice value of the launch config
  appPort: number;
  cdpPort: number;
  session?: vscode.DebugSession;
  cdp?: Cdp;
  loadedAs?: string; // the user agent the app was loaded with ('' = the browser's own); unset: not loaded yet
  view?: View;
  emulatedAt?: number; // last re-emulation after a frame of the wrong size
  density?: number; // pixels to render per device pixel: the physical size the panel shows it at (see `sized`)
  external?: boolean; // also opened in the user's browser
  panel: DevicePanel | undefined; // the panel that shows it; none while hidden (several devices at once, ADR-0099)
  title: string; // the device's name, kept while hidden
  lastView?: View;
  lastUsed: number; // last moment somebody looked at it or used it (the idle stop)
  ended?: boolean;
}

const panels = new Set<DevicePanel>();
/** Apps whose panel is closed (a tab closed by the user, a non-mobile workspace entered): they keep running headless
 * and get a panel again from the Devices workspace or when a mobile workspace is entered. */
const parked: Running[] = [];
let lastView: View | undefined;
let ctx: vscode.ExtensionContext;
let screenDpr = 1; // the monitor's device pixel ratio, reported by the webview (see `Size`)

/** How dense to render and stream the device. At least its own pixel ratio (so assets are picked as on the real
 * phone), and enough that the device shown up to the 1.5x *Fit* zoom on this monitor is not upscaled: below this the
 * 3x phones looked pixelated on a HiDPI screen. Capped so a Desktop preset does not stream huge frames. */
function captureScale(p: Preset): number {
  return Math.min(4, Math.max(p.dpr, 1.5 * screenDpr));
}

/** Every app alive, shown or hidden. */
const alive = (): Running[] => [...panels].flatMap((p) => (p.running ? [p.running] : [])).concat(parked);

/** The lowest number no device uses: a closed device frees its name. */
function freeNumber(): number {
  const used = new Set([...panels].map((p) => p.view.title).concat(parked.map((r) => r.title)));
  let n = 1;
  while (used.has(`${DEVICE_LABEL} ${n}`)) n++;
  return n;
} // the device of the last panel, the default for the next one
let nextId = 1;

/** What the Devices workspace lists. */
export interface DeviceInfo {
  id: string; // a panel's id, or `hidden:<key>` for an app without a panel
  title: string;
  status: 'idle' | 'starting' | 'live' | 'hidden';
}
export const devicesChanged = new vscode.EventEmitter<void>();
export function devices(): DeviceInfo[] {
  const shown: DeviceInfo[] = [...panels].map((p) => ({ id: p.id, title: p.view.title, status: p.running?.cdp ? 'live' : p.running ? 'starting' : 'idle' }));
  const hidden: DeviceInfo[] = parked.map((r) => ({ id: `hidden:${r.key}`, title: r.title, status: 'hidden' }));
  return shown.concat(hidden).sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
}
/** Shows a device: a hidden one gets its panel back. */
export function revealDevice(id: string): void {
  const r = parked.find((x) => `hidden:${x.key}` === id);
  if (r) return DevicePanel.adopt(ctx, r);
  [...panels].find((p) => p.id === id)?.view.reveal(undefined, true);
}
/** Stops a device's app and closes its panel (the Devices workspace's ✕): its processes end now. */
export function closeDevice(id: string): void {
  const r = alive().find((x) => x.panel?.id === id || `hidden:${x.key}` === id);
  const panel = r?.panel ?? [...panels].find((p) => p.id === id);
  if (r) endRunning(r);
  panel?.view.dispose();
}


async function selectedDevice(): Promise<string | undefined> {
  try {
    return await vscode.commands.executeCommand<string>('flutter.getSelectedDeviceId');
  } catch {
    return undefined;
  }
}

/** A Flutter launch for the Dragonfly device becomes a `chrome` launch with a headless browser whose DevTools port
 * is known. `deviceId` is set here, before the Dart extension resolves the device (it adds `-d <deviceId>` after any
 * `-d` of `toolArgs`, and Flutter takes the last one). */
function launchProvider(context: vscode.ExtensionContext): vscode.DebugConfigurationProvider {
  return {
    async resolveDebugConfiguration(_folder, config) {
      if (config.request !== 'launch') return config;
      // a relaunch (repair) of a device launch: new ports and mark, as a new launch on the same panel
      if (config.dragonflyDevice) {
        const prev = [...panels].find((p) => p.running?.key === config.dragonflyDevice);
        config = { ...config, deviceId: DEVICE_ID, toolArgs: config.dragonflyToolArgs, dragonflyDevice: undefined, dragonflyPanel: prev?.id ?? config.dragonflyPanel };
      }
      const device = config.deviceId ?? (await selectedDevice());
      if (device !== DEVICE_ID) return config;
      const [appPort, cdpPort] = [await freePort(), await freePort()];
      const target = [...panels].find((p) => p.id === config.dragonflyPanel) ?? DevicePanel.idle() ?? DevicePanel.show(context);
      target.closeRunning();
      const key = `${Date.now()}`;
      target.running = { key, appPort, cdpPort, view: target.lastView ?? lastView, panel: target, title: target.view.title, lastUsed: Date.now() };
      target.starting();
      devicesChanged.fire();
      const browser = chromium();
      return {
        ...config,
        name: target.view.title, // the debug toolbar and the Debug Console list the sessions by device
        deviceId: 'chrome',
        dragonflyDevice: key,
        dragonflyToolArgs: config.toolArgs,
        ...(browser && { env: { CHROME_EXECUTABLE: browser, ...config.env } }),
        toolArgs: [
          ...(config.toolArgs ?? []),
          '--web-port',
          String(appPort),
          '--web-hostname',
          HOST,
          '--web-browser-debug-port',
          String(cdpPort),
          // the browser starts on an empty page of Flutter's server (a missing asset: 404, no app; Flutter wants an
          // http URL) and the extension opens the app once the device is emulated (see `emulate`)
          '--web-launch-url',
          `http://${HOST}:${appPort}/assets/${marker(key)}`,
          '--web-browser-flag=--headless=new',
          // CanvasKit needs WebGL; a headless browser without a GPU draws it in software
          '--web-browser-flag=--enable-unsafe-swiftshader',
        ],
      };
    },
  };
}


/** Closes the headless browser: Flutter does not always close it when the session ends, and it would stay alive. */
async function closeBrowser(cdpPort: number): Promise<void> {
  try {
    const v = (await (await fetch(`http://${HOST}:${cdpPort}/json/version`)).json()) as { webSocketDebuggerUrl: string };
    const browser = await Cdp.open(v.webSocketDebuggerUrl);
    await browser.call('Browser.close').catch(() => undefined);
    browser.close();
  } catch {
    // already closed
  }
}

/** Connects to the app's page, applies the panel's device and streams the screen to the panel. */
async function attach(r: Running, tries?: number): Promise<void> {
  const cdp = await browserPage(r.cdpPort, tries);
  if (r.ended) return cdp.close();
  r.cdp = cdp;
  cdp.on('Page.screencastFrame', (f) => {
    void cdp.call('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
    r.panel?.frame(String(f.data));
    // a frame of another size means the emulation is gone: apply it again
    const m = f.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined;
    const v = r.view;
    const off = v && m && (Math.abs((m.deviceWidth ?? v.width) - v.width) > 1 || Math.abs((m.deviceHeight ?? v.height) - v.height) > 1);
    if (off && Date.now() - (r.emulatedAt ?? 0) > 2000) {
      r.emulatedAt = Date.now();
      void emulate(r, v).catch(() => undefined);
    }
  });
  // the emulation lives as long as this connection: when it drops while the app runs, connect again and emulate
  cdp.onclose = () => {
    if (r.ended || r.cdp !== cdp) return;
    r.cdp = undefined;
    setTimeout(() => {
      if (!r.ended && !r.cdp) void attach(r, 10).catch(() => undefined);
    }, 300);
  };
  // a new document (the app opened, a reload) stops the screencast: start it again
  cdp.on('Page.loadEventFired', () => void screencast(r).catch(() => undefined));
  await cdp.call('Page.enable');
  await emulate(r, r.view ?? { preset: 'Responsive', width: 400, height: 800, landscape: false });
}

/** Chrome's device mode for `view`. Flutter reads the platform once, when the app starts: the first time the app
 * is opened here, already emulated (one load, so the debugger never sees a reload); a later platform change
 * reloads it. */
async function emulate(r: Running, view: View): Promise<void> {
  r.view = view;
  const cdp = r.cdp;
  const p = PRESETS.find((x) => x.name === view.preset);
  if (!cdp || !p) return;
  const mobile = p.os !== 'web';
  await cdp.call('Emulation.setDeviceMetricsOverride', {
    width: view.width,
    height: view.height,
    deviceScaleFactor: r.density ?? captureScale(p),
    mobile,
    ...(mobile && {
      screenOrientation: view.landscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
    }),
  });
  await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
  await screencast(r);
  const id = identity(p);
  // set on every call: like the metrics, the user agent belongs to this connection
  const own = (await cdp.call<{ userAgent: string }>('Browser.getVersion')).userAgent;
  await cdp.call('Emulation.setUserAgentOverride', { userAgent: id.ua ?? own, platform: id.platform ?? '' });
  if ((id.ua ?? '') !== r.loadedAs) {
    const first = r.loadedAs === undefined;
    r.loadedAs = id.ua ?? '';
    if (first) await cdp.call('Page.navigate', { url: `http://${HOST}:${r.appPort}/` });
    else await cdp.call('Page.reload');
  }
}

/** Streams the page to the panel at `captureScale` physical pixels: the page is drawn at that backing-store size
 * (see `emulate`), so the frame carries the real pixels the panel shows, sharp on a HiDPI screen. jpeg at 100 keeps
 * the frames light enough to scroll smoothly while dropping the compression artefacts that read as pixelation. */
async function screencast(r: Running): Promise<void> {
  const cdp = r.cdp;
  const view = r.view;
  const p = PRESETS.find((x) => x.name === view?.preset);
  if (!cdp || !view || !p) return;
  const scale = r.density ?? captureScale(p);
  await cdp.call('Page.stopScreencast').catch(() => undefined);
  await cdp.call('Page.startScreencast', {
    format: 'jpeg',
    quality: 100,
    maxWidth: Math.round(view.width * scale),
    maxHeight: Math.round(view.height * scale),
  });
}

/** One user input from the panel, in the device's CSS pixels. */
interface Input {
  kind: 'down' | 'move' | 'up' | 'cancel' | 'wheel' | 'keyDown' | 'keyUp';
  x?: number;
  y?: number;
  dx?: number;
  dy?: number;
  key?: string;
  code?: string;
  keyCode?: number;
  modifiers?: number;
}

async function input(r: Running, i: Input): Promise<void> {
  const cdp = r.cdp;
  const p = PRESETS.find((x) => x.name === r.view?.preset);
  if (!cdp || !p) return;
  const at = { x: i.x ?? 0, y: i.y ?? 0 };
  if (i.kind === 'keyDown' || i.kind === 'keyUp') {
    const text = i.kind === 'keyDown' ? (i.key === 'Enter' ? '\r' : i.key?.length === 1 ? i.key : undefined) : undefined;
    await cdp.call('Input.dispatchKeyEvent', {
      type: i.kind === 'keyDown' ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
      key: i.key,
      code: i.code,
      windowsVirtualKeyCode: i.keyCode,
      nativeVirtualKeyCode: i.keyCode,
      modifiers: i.modifiers ?? 0,
      ...(text && { text, unmodifiedText: text }),
    });
  } else if (i.kind === 'wheel') {
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseWheel', ...at, deltaX: i.dx ?? 0, deltaY: i.dy ?? 0 });
  } else if (p.os !== 'web') {
    // a finger: drags scroll, no hover
    const type = { down: 'touchStart', move: 'touchMove', up: 'touchEnd', cancel: 'touchCancel' }[i.kind];
    const end = i.kind === 'up' || i.kind === 'cancel';
    await cdp.call('Input.dispatchTouchEvent', { type, touchPoints: end ? [] : [{ ...at, id: 1, radiusX: 1, radiusY: 1, force: 1 }] });
  } else {
    const type = { down: 'mousePressed', move: 'mouseMoved', up: 'mouseReleased', cancel: 'mouseReleased' }[i.kind];
    const pressed = i.kind === 'down' || i.kind === 'up';
    await cdp.call('Input.dispatchMouseEvent', { type, ...at, button: pressed ? 'left' : 'none', buttons: i.kind === 'down' ? 1 : 0, clickCount: pressed ? 1 : 0 });
  }
}

/** Ends an app: its session, page connection, browser and Flutter; its panel (if any) shows it stopped. */
function endRunning(r: Running): void {
  if (r.ended) return;
  r.ended = true;
  const i = parked.indexOf(r);
  if (i >= 0) parked.splice(i, 1);
  if (r.panel?.running === r) {
    r.panel.running = undefined;
    r.panel.stopped();
  }
  r.cdp?.close();
  if (r.session) void vscode.debug.stopDebugging(r.session);
  void closeBrowser(r.cdpPort);
  // Flutter does not always end when its session does (it stayed alive with its browser, hundreds of MB)
  reap(marker(r.key));
  devicesChanged.fire();
}

function watchSessions(): vscode.Disposable[] {
  const of = (s: vscode.DebugSession) => alive().find((r) => s.configuration.dragonflyDevice === r.key);
  return [
    vscode.debug.onDidStartDebugSession((s) => {
      const r = of(s);
      if (!r) {
        // its device was closed while Flutter was still building: nobody owns this app
        if (s.configuration.dragonflyDevice) {
          void vscode.debug.stopDebugging(s);
          reap(marker(String(s.configuration.dragonflyDevice)));
        }
        return;
      }
      r.session = s;
      r.panel?.view.reveal(undefined, true);
      attach(r)
        .then(() => devicesChanged.fire())
        .catch((e) => r.panel?.failed(e instanceof Error ? e.message : String(e)));
    }),
    vscode.debug.onDidTerminateDebugSession((s) => {
      const r = of(s);
      if (r) endRunning(r);
    }),
  ];
}

/** The watchdog (every minute): stops a device nobody looked at for `IDLE_LIMIT` (hidden, or its panel not
 * visible) and ends the Flutter and browser processes of this window that no device owns any more. */
function watchdog(): vscode.Disposable {
  const prefix = marker('').slice(0, -2);
  const timer = setInterval(() => {
    const now = Date.now();
    for (const r of alive()) {
      if (r.panel?.view.visible) r.lastUsed = now;
      else if (now - r.lastUsed > IDLE_LIMIT) {
        const panel = r.panel;
        endRunning(r);
        panel?.view.dispose();
      }
    }
    if (process.platform === 'win32') return;
    execFile('pgrep', ['-af', prefix], (_e, out) => {
      const live = new Set(alive().map((r) => r.key));
      const re = new RegExp(`${prefix}(\\d+)__`, 'g');
      for (const m of String(out ?? '').matchAll(re)) if (!live.has(m[1])) reap(marker(m[1]));
    });
  }, WATCH_MS);
  return { dispose: () => clearInterval(timer) };
}

// ------------------------------------------------------------------ the panel

interface Size {
  screen: number; // the screen's width in CSS pixels
  width: number; // the panel's width
  dpr: number; // the monitor's device pixel ratio (to render the device dense enough for a HiDPI screen)
  shot: number; // physical pixels the device screen spans right now (CSS width × zoom × dpr): render it to this
}

export const isDeviceGroup = (g: vscode.TabGroup) =>
  g.tabs.some((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('dragonflyDevice'));

interface EditorLayout {
  orientation: number;
  groups: { size?: number; groups?: unknown[] }[];
}

/** Gives the device's editor group `width` pixels, taken from the other groups in proportion.
 * shortcut: only for groups side by side (no nested splits); a nested layout keeps its sizes. */
async function setGroupWidth(width: number, column: vscode.ViewColumn | undefined): Promise<void> {
  const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === column && isDeviceGroup(g));
  const layout = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
  if (!group || !layout || layout.orientation !== 0 || layout.groups.some((g) => g.groups?.length || !g.size)) return;
  const i = group.viewColumn - 1;
  const total = layout.groups.reduce((a, g) => a + g.size!, 0);
  const rest = total - (layout.groups[i]?.size ?? total);
  if (rest <= 0 || width >= total) return;
  const scale = (total - width) / rest;
  await vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 0,
    groups: layout.groups.map((g, j) => ({ size: j === i ? width : g.size! * scale })),
  });
}

/** Locks the device's editor group (VS Code's *Lock Group*): files, pauses and generated code open in another group. */
async function lockDeviceGroup(back: vscode.TextEditor | undefined): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
  if (back) await vscode.window.showTextDocument(back.document, { viewColumn: back.viewColumn, preserveFocus: false });
}

class DevicePanel {
  readonly id = `device-${nextId++}`;
  running: Running | undefined;
  lastView: View | undefined;
  private disposed = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    readonly view: vscode.WebviewPanel,
  ) {
    panels.add(this);
    view.onDidDispose(() => {
      panels.delete(this);
      this.disposed = true;
      // closing the tab only hides the device: its app and session go on (the Devices workspace stops it)
      const r = this.running;
      this.running = undefined;
      if (r && !r.ended) {
        r.panel = undefined;
        r.lastView = this.lastView;
        parked.push(r);
        void r.cdp?.call('Page.stopScreencast').catch(() => undefined);
      }
      devicesChanged.fire();
    });
    view.onDidChangeViewState(() => {
      if (view.visible && this.running) this.running.lastUsed = Date.now();
    });
    view.webview.onDidReceiveMessage((m: { type: string; state?: unknown; view?: View; input?: Input; size?: Size }) => {
      const r = this.running;
      switch (m.type) {
        case 'view':
          this.lastView = m.view;
          lastView = m.view;
          if (r && m.view) emulate(r, m.view).catch(() => undefined);
          break;
        case 'input':
          if (r) r.lastUsed = Date.now();
          if (r && m.input) input(r, m.input).catch(() => undefined);
          break;
        case 'state':
          void context.globalState.update(STATE_KEY, m.state);
          break;
        case 'size':
          if (m.size) void this.sized(m.size);
          break;
        case 'run':
          void vscode.commands.executeCommand('nuclear.runOnDevice', this.id);
          break;
        case 'reload':
          void vscode.commands.executeCommand('flutter.hotReload');
          break;
        case 'restart':
          void vscode.commands.executeCommand('flutter.hotRestart');
          break;
        case 'stop':
          if (r) endRunning(r); // also while Flutter is still building (no session yet)
          break;
        case 'browser':
          if (r) r.external = true;
          if (r) void vscode.env.openExternal(vscode.Uri.parse(`http://${HOST}:${r.appPort}/`));
          break;
      }
    });
    view.webview.html = this.html();
    this.stopped();
    devicesChanged.fire();
  }

  /** Ends the app of this panel (session, browser, Flutter). */
  closeRunning(): void {
    const r = this.running;
    this.running = undefined;
    devicesChanged.fire();
    if (r) endRunning(r);
  }

  /** The first panel without an app: a run without a chosen device never replaces a running one. */
  static idle(): DevicePanel | undefined {
    return [...panels].find((p) => !p.running);
  }

  /** Closes every panel but keeps its app running (leaving the mobile workspaces). */
  static park(): void {
    for (const p of [...panels]) p.view.dispose();
  }

  /** Gives the hidden apps a panel again, side by side (entering a mobile workspace or the Devices tool). */
  static unpark(context: vscode.ExtensionContext): void {
    for (const r of parked.splice(0)) DevicePanel.adopt(context, r);
  }

  /** A panel for a hidden app. */
  static adopt(context: vscode.ExtensionContext, r: Running): void {
    const i = parked.indexOf(r);
    if (i >= 0) parked.splice(i, 1);
    const panel = DevicePanel.show(context, undefined, r.title);
    panel.lastView = r.lastView;
    panel.running = r;
    r.panel = panel;
    r.lastUsed = Date.now();
    if (r.cdp) {
      void screencast(r).catch(() => undefined);
      panel.post({ type: 'live' });
    } else if (r.session) {
      panel.starting();
      attach(r, 10).catch((e) => panel.failed(e instanceof Error ? e.message : String(e)));
    }
    devicesChanged.fire();
  }

  /** A new device, in its own locked editor group beside the others, like one more emulator. */
  static show(context: vscode.ExtensionContext, preset?: string, title?: string): DevicePanel {
    const back = vscode.window.activeTextEditor;
    // created with focus so its group is the active one when it gets locked
    const view = vscode.window.createWebviewPanel(
      'dragonflyDevice',
      title ?? `${DEVICE_LABEL} ${freeNumber()}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    view.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icons', 'nuc-file.svg');
    const panel = new DevicePanel(context, view);
    if (preset) panel.post({ type: 'preset', name: preset });
    void lockDeviceGroup(back);
    return panel;
  }

  private widthSet = false;
  private saveTimer: NodeJS.Timeout | undefined;

  /** The first size report gives the panel its width (the one the user left on this screen, or a default); the
   * next ones (the user dragging the border) are remembered. */
  private async sized(s: Size): Promise<void> {
    if (s.dpr) screenDpr = s.dpr;
    // render (and stream) the app at the physical pixels the panel shows it at, so nothing is upscaled: a frame that
    // matches the screen 1:1 is as sharp as the monitor allows. Only ever raise it (shrinking the panel keeps the
    // crisper frames), capped so a huge panel does not stream absurd frames.
    const r = this.running;
    const p = PRESETS.find((x) => x.name === r?.view?.preset);
    if (r?.cdp && r.view && p && s.shot) {
      const want = Math.min(4, Math.max(p.dpr, s.shot / r.view.width));
      if (want > (r.density ?? 0) + 0.1) {
        r.density = want;
        void emulate(r, r.view).catch(() => undefined);
      }
    }
    const widths = this.context.globalState.get<Record<string, number>>(WIDTHS_KEY, {});
    if (!this.widthSet) {
      this.widthSet = true;
      const want = widths[s.screen] ?? defaultWidth(s.screen);
      if (Math.abs(want - s.width) > 8) await setGroupWidth(want, this.view.viewColumn);
      return;
    }
    // a hidden or maximized panel is not a width to keep
    if (s.width < 200 || s.width > s.screen * 0.7) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.context.globalState.update(WIDTHS_KEY, { ...widths, [s.screen]: Math.round(s.width) }), 600);
  }

  private post(m: object): void {
    if (!this.disposed) void this.view.webview.postMessage(m);
  }

  starting(): void {
    this.post({ type: 'starting' });
  }

  frame(data: string): void {
    this.post({ type: 'frame', data });
  }

  failed(message: string): void {
    this.post({ type: 'failed', message });
  }

  stopped(): void {
    this.post({ type: 'stopped' });
  }

  private html(): string {
    const nonce = Math.random().toString(36).slice(2);
    const state = JSON.stringify(this.context.globalState.get(STATE_KEY) ?? {});
    const presets = JSON.stringify(PRESETS);
    return /* html */ `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src data:;">
<style>
:root { --bar: var(--vscode-editorWidget-background); --line: var(--vscode-panel-border, #4446); }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; overflow: hidden; color: var(--vscode-foreground); font: 12px var(--vscode-font-family); background: var(--vscode-editor-background); }
#bar { display: flex; align-items: center; gap: 6px; height: 34px; padding: 0 8px; background: var(--bar); border-bottom: 1px solid var(--line); white-space: nowrap; overflow-x: auto; }
#bar .sep { width: 1px; height: 18px; background: var(--line); margin: 0 2px; }
#bar .grow { flex: 1; }
select, input { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 2px; height: 22px; font: inherit; }
input { width: 52px; text-align: center; }
input:disabled { opacity: .6; }
button { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 24px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: inherit; cursor: pointer; }
button:hover { background: var(--vscode-toolbar-hoverBackground); }
button:disabled { opacity: .35; cursor: default; background: transparent; }
button svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.label { opacity: .75; }
#os { opacity: .75; min-width: 54px; }
#stage { position: absolute; top: 34px; left: 0; right: 0; bottom: 0; overflow: auto; display: grid; place-items: center; background: var(--vscode-sideBar-background); outline: none; }
#scaler { transform-origin: top left; }
#device { position: relative; display: inline-block; vertical-align: top; background: #111; }
/* the island sits in the bezel, not on the screen: the emulated page has no safe areas */
#device.phone { padding: 40px 14px 14px; border-radius: 46px; box-shadow: 0 0 0 2px #3a3a3a, 0 12px 40px #0008; }
#device.phone.landscape { padding: 14px 14px 14px 40px; }
#device.phone::before { content: ''; position: absolute; top: 11px; left: 50%; width: 90px; height: 20px; margin-left: -45px; border-radius: 12px; background: #000; pointer-events: none; }
#device.phone.landscape::before { top: 50%; left: 11px; width: 20px; height: 90px; margin: -45px 0 0; }
#device.tablet { padding: 22px; border-radius: 30px; box-shadow: 0 0 0 2px #3a3a3a, 0 12px 40px #0008; }
#device.none { padding: 0; box-shadow: 0 0 0 1px var(--line), 0 8px 30px #0006; }
#screen { position: relative; overflow: hidden; background: #fff; touch-action: none; user-select: none; }
#device.phone #screen { border-radius: 34px; }
#device.tablet #screen { border-radius: 10px; }
#app { display: block; width: 100%; height: 100%; -webkit-user-drag: none; pointer-events: none; }
#device.touch #screen { cursor: default; }
/* the cover is scaled with the device: its text keeps the size of the editor's */
#cover { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: calc(12px / var(--z, 1)); background: #1e1e1e; color: #ccc; text-align: center; padding: 20px; font-size: calc(13px / var(--z, 1)); }
#cover button.run { width: auto; height: calc(28px / var(--z, 1)); padding: 0 calc(14px / var(--z, 1)); font-size: inherit; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.spin { width: calc(26px / var(--z, 1)); height: calc(26px / var(--z, 1)); border: calc(3px / var(--z, 1)) solid #555; border-top-color: #4fc3f7; border-radius: 50%; animation: s 0.9s linear infinite; }
@keyframes s { to { transform: rotate(360deg); } }
.handle { position: absolute; background: transparent; z-index: 3; }
.handle.r { top: 0; right: -10px; width: 10px; height: 100%; cursor: ew-resize; }
.handle.b { left: 0; bottom: -10px; width: 100%; height: 10px; cursor: ns-resize; }
.handle.rb { right: -14px; bottom: -14px; width: 14px; height: 14px; cursor: nwse-resize; }
.handle:hover, .dragging .handle { background: var(--vscode-focusBorder); opacity: .5; }
#device:not(.responsive) .handle { display: none; }
</style></head><body>
<div id="bar">
  <span class="label">Dimensions:</span>
  <select id="preset" title="Device"></select>
  <input id="w" type="number" min="100" max="4000" title="Width">
  <span class="label">×</span>
  <input id="h" type="number" min="100" max="4000" title="Height">
  <select id="zoom" title="Zoom">
    <option value="fit">Fit to window</option><option value="0.5">50%</option><option value="0.75">75%</option>
    <option value="1">100%</option><option value="1.25">125%</option><option value="1.5">150%</option>
  </select>
  <button id="rotate" title="Rotate"><svg viewBox="0 0 16 16"><rect x="4" y="1.5" width="8" height="13" rx="1.5"/><path d="M14.5 6.5a6 6 0 0 0-3-4M1.5 9.5a6 6 0 0 0 3 4"/></svg></button>
  <span id="os"></span>
  <span class="grow"></span>
  <button id="reload" title="Hot Reload"><svg viewBox="0 0 16 16"><path d="M9 1.5 4 9h4l-1 5.5L12 7H8z"/></svg></button>
  <button id="restart" title="Hot Restart"><svg viewBox="0 0 16 16"><path d="M13.5 8A5.5 5.5 0 1 1 11 3.4"/><path d="M11.5 1v3h-3"/></svg></button>
  <button id="stop" title="Stop"><svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1"/></svg></button>
  <span class="sep"></span>
  <button id="browser" title="Open in the browser"><svg viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M11.5 9.5v4h-9v-9h4"/></svg></button>
</div>
<div id="stage" tabindex="0"><div id="scaler"><div id="device">
  <div id="screen"><img id="app" alt=""><div id="cover"></div></div>
  <div class="handle r"></div><div class="handle b"></div><div class="handle rb"></div>
</div></div></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const PRESETS = ${presets};
const st = Object.assign({ preset: 'iPhone 14 Pro', w: 400, h: 800, zoom: 'fit', landscape: false }, ${state});
const $ = (id) => document.getElementById(id);
const preset = $('preset'), w = $('w'), h = $('h'), zoom = $('zoom'), img = $('app'), cover = $('cover');
const device = $('device'), screen = $('screen'), scaler = $('scaler'), stage = $('stage');
for (const p of PRESETS) preset.add(new Option(p.name, p.name));
if (!PRESETS.some((p) => p.name === st.preset)) st.preset = 'iPhone 14 Pro';
preset.value = st.preset; zoom.value = st.zoom;
let live = false, sentView = '';

const current = () => PRESETS.find((p) => p.name === st.preset);
function size() {
  const p = current();
  const base = p.name === 'Responsive' ? [st.w, st.h] : [p.width, p.height];
  return st.landscape ? [base[1], base[0]] : base;
}
// the device always fits the panel (or the chosen zoom), whatever the panel's size
function layout() {
  const p = current(), [cw, ch] = size();
  w.value = cw; h.value = ch;
  w.disabled = h.disabled = p.name !== 'Responsive';
  $('os').textContent = { ios: 'iOS', android: 'Android', web: 'Web' }[p.os];
  device.className = p.frame + (p.name === 'Responsive' ? ' responsive' : '') + (st.landscape ? ' landscape' : '') + (p.os !== 'web' ? ' touch' : '');
  screen.style.width = cw + 'px'; screen.style.height = ch + 'px';
  const thick = { phone: [28, 54], tablet: [44, 44], none: [0, 0] }[p.frame];
  const [pw, ph] = st.landscape ? [thick[1], thick[0]] : thick;
  let z = Number(st.zoom);
  // up to 1.5: on a big screen the phone reaches about its real size
  if (st.zoom === 'fit') z = Math.max(0.05, Math.min(1.5, (stage.clientWidth - 32) / (cw + pw), (stage.clientHeight - 32) / (ch + ph)));
  scaler.style.transform = 'scale(' + z + ')';
  scaler.style.width = (cw + pw) * z + 'px'; scaler.style.height = (ch + ph) * z + 'px';
  scaler.dataset.z = z;
  scaler.style.setProperty('--z', z);
  const view = { preset: p.name, width: cw, height: ch, landscape: !!st.landscape };
  const key = JSON.stringify(view);
  if (key !== sentView) { sentView = key; vscode.postMessage({ type: 'view', view }); }
  vscode.postMessage({ type: 'state', state: st });
  if (innerWidth > 0) vscode.postMessage({ type: 'size', size: { screen: window.screen.width, width: innerWidth, dpr: window.devicePixelRatio, shot: Math.ceil(cw * z * window.devicePixelRatio) } });
}
function setCover(html) { cover.innerHTML = html; cover.style.display = html ? 'flex' : 'none'; }
function controls(on) { for (const id of ['reload', 'restart', 'stop', 'browser']) $(id).disabled = !on; }

preset.onchange = () => { st.preset = preset.value; layout(); };
zoom.onchange = () => { st.zoom = zoom.value; layout(); };
w.onchange = () => { st.w = Math.max(100, +w.value || 400); layout(); };
h.onchange = () => { st.h = Math.max(100, +h.value || 800); layout(); };
$('rotate').onclick = () => { st.landscape = !st.landscape; layout(); };
for (const id of ['reload', 'restart', 'stop', 'browser']) $(id).onclick = () => vscode.postMessage({ type: id });
new ResizeObserver(layout).observe(stage);
window.addEventListener('resize', layout);

// input: positions come from where the screen is drawn now, so any size or zoom of the panel maps right
function at(e) {
  const r = screen.getBoundingClientRect(), [cw, ch] = size();
  return { x: Math.max(0, Math.min(cw, (e.clientX - r.left) / r.width * cw)), y: Math.max(0, Math.min(ch, (e.clientY - r.top) / r.height * ch)) };
}
const send = (input) => vscode.postMessage({ type: 'input', input });
let down = false, moveQueued = null;
screen.addEventListener('pointerdown', (e) => {
  if (!live || e.button !== 0) return;
  e.preventDefault(); stage.focus(); screen.setPointerCapture(e.pointerId); down = true;
  send({ kind: 'down', ...at(e) });
});
screen.addEventListener('pointermove', (e) => {
  if (!live || (!down && current().os !== 'web')) return;
  // one move per frame
  if (!moveQueued) requestAnimationFrame(() => { send({ kind: 'move', ...moveQueued }); moveQueued = null; });
  moveQueued = at(e);
});
for (const type of ['pointerup', 'pointercancel']) screen.addEventListener(type, (e) => {
  if (!live || !down) return;
  down = false; send({ kind: type === 'pointerup' ? 'up' : 'cancel', ...at(e) });
});
screen.addEventListener('wheel', (e) => {
  if (!live) return;
  e.preventDefault(); send({ kind: 'wheel', ...at(e), dx: e.deltaX, dy: e.deltaY });
}, { passive: false });
const mods = (e) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
for (const type of ['keydown', 'keyup']) stage.addEventListener(type, (e) => {
  if (!live) return;
  e.preventDefault(); e.stopPropagation();
  send({ kind: type === 'keydown' ? 'keyDown' : 'keyUp', key: e.key, code: e.code, keyCode: e.keyCode, modifiers: mods(e) });
});

// responsive: drag the right / bottom edges like the browsers' device toolbar
for (const el of document.querySelectorAll('.handle')) {
  el.onpointerdown = (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const [sw, sh] = size(), x0 = e.clientX, y0 = e.clientY, z = +scaler.dataset.z, flip = st.landscape;
    device.classList.add('dragging');
    el.onpointermove = (m) => {
      let nw = sw, nh = sh;
      if (!el.classList.contains('b')) nw = Math.max(100, Math.round(sw + (m.clientX - x0) / z));
      if (!el.classList.contains('r')) nh = Math.max(100, Math.round(sh + (m.clientY - y0) / z));
      if (flip) { st.w = nh; st.h = nw; } else { st.w = nw; st.h = nh; }
      layout();
    };
    el.onpointerup = () => { el.onpointermove = null; device.classList.remove('dragging'); };
  };
}

window.addEventListener('message', (e) => {
  if (e.data.type === 'preset' && PRESETS.some((p) => p.name === e.data.name)) { st.preset = e.data.name; preset.value = st.preset; layout(); }
  const m = e.data;
  if (m.type === 'frame') {
    img.src = 'data:image/jpeg;base64,' + m.data;
    if (!live) { live = true; controls(true); setCover(''); }
  } else if (m.type === 'live') {
    controls(true); sentView = ''; layout();
  } else if (m.type === 'starting') {
    live = false; controls(false); img.removeAttribute('src'); sentView = ''; layout();
    setCover('<div class="spin"></div><div>Starting the app on the Dragonfly device…<br><small>first build of Flutter web: it takes a while</small></div>');
  } else if (m.type === 'failed') {
    setCover('<div>The Dragonfly device could not show the app:<br><small>' + String(m.message).replace(/</g, '&lt;') + '</small></div>');
  } else if (m.type === 'stopped') {
    live = false; controls(false); img.removeAttribute('src');
    setCover('<div>The app is not running on the Dragonfly device.</div><button class="run" id="run">▷ Run</button>');
    $('run').onclick = () => vscode.postMessage({ type: 'run' });
  }
});
layout();
</script></body></html>`;
  }
}

// ------------------------------------------------------------------ activation

/** `run(deviceId)` launches the project's app (build first) on that device. */
export function activateDevice(
  context: vscode.ExtensionContext,
  find: (root?: string) => Project | undefined,
  run: (deviceId: string, extra: Record<string, unknown>, root?: string, noDebug?: boolean) => Promise<void>,
): void {
  ctx = context;
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('dart', launchProvider(context)),
    ...watchSessions(),
    watchdog(),
    vscode.commands.registerCommand('nuclear.closeDevice', (id: string) => closeDevice(id)),
    vscode.commands.registerCommand('nuclear.openDevice', (preset?: string): { id: string } => ({ id: DevicePanel.show(context, typeof preset === 'string' ? preset : undefined).id })),
    vscode.commands.registerCommand('nuclear.parkDevices', () => DevicePanel.park()),
    vscode.commands.registerCommand('nuclear.unparkDevices', () => DevicePanel.unpark(context)),
    // `panelId` names the device to run on (its ▷ Run, the Devices workspace); without it a free one, or a new one
    vscode.commands.registerCommand('nuclear.runOnDevice', async (panelId?: unknown, root?: string, noDebug?: boolean) => {
      const p = find(root);
      if (!p) {
        void vscode.window.showWarningMessage('Not a Dragonfly project: run `dragonfly build` in the project first.');
        return;
      }
      const hidden = typeof panelId === 'string' ? parked.find((r) => `hidden:${r.key}` === panelId) : undefined;
      if (hidden) DevicePanel.adopt(context, hidden);
      const target = (typeof panelId === 'string' && [...panels].find((d) => d.id === panelId || d.running === hidden)) || DevicePanel.idle() || DevicePanel.show(context);
      target.view.reveal(undefined, true);
      await run(DEVICE_ID, { dragonflyPanel: target.id }, root, noDebug);
    }),
  );
  // VS Code closed or crashed: end every app this window started on the device
  reap(marker('').slice(0, -2), process.pid);
  const p = find();
  if (p) void ensureDevice(p);
}
