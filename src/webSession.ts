// The web device's engine, without VS Code: a web app of the Dragonfly web platform served by its dialect's dev server
// and shown by a headless browser driven over CDP. It emulates a viewport (a desktop, a laptop, a tablet, a phone with
// its user agent and touch), the color scheme and the network, and reports what a developer looks at: frames of the
// page, its console, its requests and its address. `webDevice.ts` puts it in a panel of the editor.
import { ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { browserPage, Cdp, freePort } from './cdp';

export interface WebPreset {
  name: string;
  width: number;
  height: number;
  dpr: number;
  kind: 'desktop' | 'tablet' | 'phone';
  ua?: string;
  platform?: string;
}

const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

/** The browsers' device toolbar, with the screens a web app is built for first (CSS pixels, portrait). */
export const WEB_PRESETS: WebPreset[] = [
  { name: 'Responsive', width: 1280, height: 800, dpr: 1, kind: 'desktop' },
  { name: 'Desktop', width: 1920, height: 1080, dpr: 1, kind: 'desktop' },
  { name: 'Laptop L', width: 1440, height: 900, dpr: 2, kind: 'desktop' },
  { name: 'Laptop', width: 1280, height: 800, dpr: 1, kind: 'desktop' },
  { name: 'iPad Pro', width: 1024, height: 1366, dpr: 2, kind: 'tablet', ua: IPAD_UA, platform: 'iPad' },
  { name: 'iPad Air', width: 820, height: 1180, dpr: 2, kind: 'tablet', ua: IPAD_UA, platform: 'iPad' },
  { name: 'iPad Mini', width: 768, height: 1024, dpr: 2, kind: 'tablet', ua: IPAD_UA, platform: 'iPad' },
  { name: 'iPhone 15 Pro Max', width: 430, height: 932, dpr: 3, kind: 'phone', ua: IOS_UA, platform: 'iPhone' },
  { name: 'iPhone 14 Pro', width: 393, height: 852, dpr: 3, kind: 'phone', ua: IOS_UA, platform: 'iPhone' },
  { name: 'iPhone SE', width: 375, height: 667, dpr: 2, kind: 'phone', ua: IOS_UA, platform: 'iPhone' },
  { name: 'Pixel 7', width: 412, height: 915, dpr: 2.625, kind: 'phone', ua: ANDROID_UA, platform: 'Linux armv8l' },
  { name: 'Galaxy S20 Ultra', width: 412, height: 915, dpr: 3.5, kind: 'phone', ua: ANDROID_UA, platform: 'Linux armv8l' },
];

/** The network conditions of Chrome's throttling menu (latency ms, bytes per second). */
export const THROTTLES: Record<string, { offline: boolean; latency: number; down: number; up: number }> = {
  none: { offline: false, latency: 0, down: -1, up: -1 },
  'fast-4g': { offline: false, latency: 60, down: (9 * 1024 * 1024) / 8, up: (1.5 * 1024 * 1024) / 8 },
  'slow-3g': { offline: false, latency: 400, down: (400 * 1024) / 8, up: (400 * 1024) / 8 },
  offline: { offline: true, latency: 0, down: 0, up: 0 },
};

/** What the panel shows and asks for: the viewport, its zoom-independent density and the developer's options. */
export interface WebView {
  preset: string;
  width: number;
  height: number;
  landscape: boolean;
  scheme: 'system' | 'light' | 'dark';
  throttle: keyof typeof THROTTLES | string;
  noCache: boolean;
}

export interface ConsoleEntry {
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  text: string;
  source?: string; // url:line of the call
  at: number;
}

export interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  type: string;
  status?: number;
  size?: number;
  ms?: number;
  failed?: string;
  at: number;
}

export interface WebInput {
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

export interface WebEvents {
  frame(jpegBase64: string): void;
  console(e: ConsoleEntry): void;
  network(e: NetworkEntry): void;
  address(url: string, canBack: boolean, canForward: boolean): void;
  log(line: string): void; // the dev server's and the browser's own output
}

/** The browser to drive: `CHROME_EXECUTABLE`, then the Chromium browsers usually installed. */
export function browserExecutable(): string | undefined {
  const isFile = (f: string) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  };
  if (process.env.CHROME_EXECUTABLE && isFile(process.env.CHROME_EXECUTABLE)) return process.env.CHROME_EXECUTABLE;
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave', 'brave-browser', 'microsoft-edge', 'microsoft-edge-stable', 'vivaldi'];
  if (process.platform === 'darwin') {
    return ['Google Chrome.app/Contents/MacOS/Google Chrome', 'Chromium.app/Contents/MacOS/Chromium', 'Brave Browser.app/Contents/MacOS/Brave Browser', 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge']
      .map((a) => `/Applications/${a}`)
      .find(isFile);
  }
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean) as string[];
    return roots
      .flatMap((r) => [path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')])
      .find(isFile);
  }
  return names.flatMap((n) => (process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, n))).find(isFile);
}

const HOST = '127.0.0.1';

/** Ends a process and what it started: its group on Linux and macOS, its tree on Windows. */
function end(p: ChildProcess): void {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F']);
    else process.kill(-(p.pid as number), 'SIGTERM');
  } catch {
    p.kill();
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A web app running on the device. `start` serves it and opens the page; `stop` ends both processes. */
export class WebSession {
  url = '';
  cdpPort = 0;
  private server?: ChildProcess;
  private browser?: ChildProcess;
  private profile?: string;
  private cdp?: Cdp;
  private view?: WebView;
  private loadedAs?: string; // the user agent the page was loaded with
  private requests = new Map<string, NetworkEntry>();
  private density = 1;
  stopped = false;

  /** `serve`: the dialect's `toolchain.serve` (`{{port}}`, `{{host}}`), run in `app`. */
  constructor(
    readonly app: string,
    private readonly serve: string | undefined,
    private readonly events: WebEvents,
    private readonly mark = `__nuclear_web_device_${process.pid}_`,
  ) {}

  async start(view: WebView, density: number): Promise<void> {
    this.density = density;
    if (!this.serve) throw new Error("the project's dialect declares no toolchain.serve (how to serve its app on a port)");
    const port = await freePort();
    this.url = `http://${HOST}:${port}/`;
    // the dialect's dev server (react: Vite) on the port and host chosen here, in the system's shell
    const command = this.serve.replaceAll('{{port}}', String(port)).replaceAll('{{host}}', HOST);
    this.server = spawn(command, {
      cwd: this.app,
      shell: true,
      // its own process group, so stopping ends the shell and the server it started
      detached: process.platform !== 'win32',
      env: { ...process.env, FORCE_COLOR: '0', NUCLEAR_DEVICE: this.mark },
    });
    this.pipe(this.server, 'server');
    await this.until(async () => (await fetch(this.url)).ok, 120, 'the dev server did not start');
    const exe = browserExecutable();
    if (!exe) throw new Error('no Chromium browser found (Chrome, Chromium, Brave or Edge; or set CHROME_EXECUTABLE)');
    this.cdpPort = await freePort();
    this.profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nuclear-web-device-'));
    this.browser = spawn(exe, [
      '--headless=new',
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${this.profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--mute-audio',
      `--class=${this.mark}browser`,
      'about:blank',
    ]);
    this.pipe(this.browser, 'browser');
    const cdp = (this.cdp = await browserPage(this.cdpPort, 60));
    cdp.onclose = () => this.stop();
    cdp.on('Page.screencastFrame', (p) => {
      void cdp.call('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => undefined);
      this.events.frame(String(p.data));
    });
    cdp.on('Runtime.consoleAPICalled', (p) => {
      const args = (p.args as { type: string; value?: unknown; description?: string }[]) ?? [];
      const text = args.map((a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : (a.description ?? a.type))).join(' ');
      const frame = ((p.stackTrace as { callFrames?: { url: string; lineNumber: number }[] })?.callFrames ?? [])[0];
      const type = String(p.type);
      const level = (type === 'warning' ? 'warn' : ['log', 'info', 'warn', 'error', 'debug'].includes(type) ? type : 'log') as ConsoleEntry['level'];
      this.events.console({ level, text, source: frame && `${frame.url}:${frame.lineNumber + 1}`, at: Date.now() });
    });
    cdp.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails as { text: string; url?: string; lineNumber?: number; exception?: { description?: string } };
      this.events.console({ level: 'error', text: d.exception?.description ?? d.text, source: d.url && `${d.url}:${(d.lineNumber ?? 0) + 1}`, at: Date.now() });
    });
    cdp.on('Log.entryAdded', (p) => {
      const e = p.entry as { level: string; text: string; url?: string };
      const level = (e.level === 'warning' ? 'warn' : e.level === 'verbose' ? 'debug' : e.level) as ConsoleEntry['level'];
      this.events.console({ level, text: e.text, source: e.url, at: Date.now() });
    });
    cdp.on('Network.requestWillBeSent', (p) => {
      const r = p.request as { method: string; url: string };
      const e: NetworkEntry = { id: String(p.requestId), method: r.method, url: r.url, type: String(p.type ?? 'Other'), at: Date.now() };
      this.requests.set(e.id, e);
      this.events.network(e);
    });
    cdp.on('Network.responseReceived', (p) => {
      const e = this.requests.get(String(p.requestId));
      if (!e) return;
      e.status = (p.response as { status: number }).status;
      e.type = String(p.type ?? e.type);
    });
    cdp.on('Network.loadingFinished', (p) => {
      const e = this.requests.get(String(p.requestId));
      if (!e) return;
      e.size = Number(p.encodedDataLength ?? 0);
      e.ms = Date.now() - e.at;
      this.events.network(e);
    });
    cdp.on('Network.loadingFailed', (p) => {
      const e = this.requests.get(String(p.requestId));
      if (!e) return;
      e.failed = String(p.errorText ?? 'failed');
      e.ms = Date.now() - e.at;
      this.events.network(e);
    });
    cdp.on('Page.frameNavigated', (p) => {
      const f = p.frame as { parentId?: string; url: string };
      if (!f.parentId) void this.reportAddress(f.url);
    });
    cdp.on('Page.navigatedWithinDocument', (p) => void this.reportAddress(String(p.url)));
    await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable'].map((m) => cdp.call(m)));
    await this.emulate(view);
  }

  /** The viewport, identity, color scheme and network of `view`; the page loads (again) when its user agent changes. */
  async emulate(view: WebView, density = this.density): Promise<void> {
    this.view = view;
    this.density = density;
    const cdp = this.cdp;
    const p = WEB_PRESETS.find((x) => x.name === view.preset) ?? WEB_PRESETS[0];
    if (!cdp) return;
    const mobile = p.kind !== 'desktop';
    await cdp.call('Emulation.setDeviceMetricsOverride', {
      width: view.width,
      height: view.height,
      deviceScaleFactor: Math.max(p.dpr, density),
      mobile,
      ...(mobile && { screenOrientation: view.landscape ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 } }),
    });
    await cdp.call('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
    await cdp.call('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: view.scheme === 'system' ? '' : view.scheme }],
    });
    const t = THROTTLES[view.throttle] ?? THROTTLES.none;
    await cdp.call('Network.emulateNetworkConditions', { offline: t.offline, latency: t.latency, downloadThroughput: t.down, uploadThroughput: t.up });
    await cdp.call('Network.setCacheDisabled', { cacheDisabled: view.noCache });
    const own = (await cdp.call<{ userAgent: string }>('Browser.getVersion')).userAgent.replace('HeadlessChrome', 'Chrome');
    await cdp.call('Emulation.setUserAgentOverride', { userAgent: p.ua ?? own, platform: p.platform ?? '' });
    await this.screencast();
    if ((p.ua ?? '') !== this.loadedAs) {
      const first = this.loadedAs === undefined;
      this.loadedAs = p.ua ?? '';
      if (first) await cdp.call('Page.navigate', { url: this.url });
      else await cdp.call('Page.reload');
    }
  }

  private async screencast(): Promise<void> {
    const cdp = this.cdp;
    const v = this.view;
    const p = WEB_PRESETS.find((x) => x.name === v?.preset) ?? WEB_PRESETS[0];
    if (!cdp || !v) return;
    const scale = Math.max(p.dpr, this.density);
    await cdp.call('Page.stopScreencast').catch(() => undefined);
    await cdp.call('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: Math.round(v.width * scale), maxHeight: Math.round(v.height * scale) });
  }

  /** An address of the app (`/docs/a`) or any url. */
  async go(address: string): Promise<void> {
    const url = /^[a-z]+:/i.test(address) ? address : new URL(address.startsWith('/') ? address : `/${address}`, this.url).href;
    await this.cdp?.call('Page.navigate', { url });
  }

  async reload(hard = false): Promise<void> {
    await this.cdp?.call('Page.reload', { ignoreCache: hard });
  }

  async history(step: -1 | 1): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    const h = await cdp.call<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
    const to = h.entries[h.currentIndex + step];
    if (to) await cdp.call('Page.navigateToHistoryEntry', { entryId: to.id });
  }

  /** The page as a PNG (base64), at its own density. */
  async screenshot(): Promise<string | undefined> {
    return (await this.cdp?.call<{ data: string }>('Page.captureScreenshot', { format: 'png' }))?.data;
  }

  /** The address of Chrome's full DevTools for this page (opened in a real browser). */
  async devtoolsUrl(): Promise<string | undefined> {
    const targets = (await (await fetch(`http://${HOST}:${this.cdpPort}/json/list`)).json()) as { type: string; devtoolsFrontendUrl?: string }[];
    const page = targets.find((t) => t.type === 'page');
    return page?.devtoolsFrontendUrl && new URL(page.devtoolsFrontendUrl, `http://${HOST}:${this.cdpPort}`).href;
  }

  async input(i: WebInput): Promise<void> {
    const cdp = this.cdp;
    const p = WEB_PRESETS.find((x) => x.name === this.view?.preset) ?? WEB_PRESETS[0];
    if (!cdp) return;
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
    } else if (p.kind !== 'desktop') {
      const type = { down: 'touchStart', move: 'touchMove', up: 'touchEnd', cancel: 'touchCancel' }[i.kind];
      const end = i.kind === 'up' || i.kind === 'cancel';
      await cdp.call('Input.dispatchTouchEvent', { type, touchPoints: end ? [] : [{ ...at, id: 1, radiusX: 1, radiusY: 1, force: 1 }] });
    } else {
      const type = { down: 'mousePressed', move: 'mouseMoved', up: 'mouseReleased', cancel: 'mouseReleased' }[i.kind];
      const pressed = i.kind === 'down' || i.kind === 'up';
      await cdp.call('Input.dispatchMouseEvent', { type, ...at, button: pressed ? 'left' : 'none', buttons: i.kind === 'down' ? 1 : 0, clickCount: pressed ? 1 : 0 });
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cdp?.close();
    for (const p of [this.browser, this.server]) {
      if (p && p.exitCode === null && p.pid) end(p);
    }
    if (this.profile) fs.rm(this.profile, { recursive: true, force: true }, () => undefined);
  }

  private async reportAddress(url: string): Promise<void> {
    const h = await this.cdp?.call<{ currentIndex: number; entries: unknown[] }>('Page.getNavigationHistory').catch(() => undefined);
    this.events.address(url, !!h && h.currentIndex > 0, !!h && h.currentIndex < h.entries.length - 1);
  }

  private pipe(p: ChildProcess, name: string): void {
    const each = (d: Buffer) => {
      for (const line of d.toString().split('\n')) if (line.trim()) this.events.log(`[${name}] ${line}`);
    };
    p.stdout?.on('data', each);
    p.stderr?.on('data', each);
    p.on('exit', (code) => {
      if (!this.stopped) this.events.log(`[${name}] exited (${code ?? 'signal'})`);
    });
  }

  private async until(test: () => Promise<boolean>, seconds: number, error: string): Promise<void> {
    for (let i = 0; i < seconds * 4; i++) {
      if (this.stopped) throw new Error('stopped');
      try {
        if (await test()) return;
      } catch {
        // not yet
      }
      await sleep(250);
    }
    throw new Error(error);
  }
}
