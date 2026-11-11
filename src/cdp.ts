// A small client of the Chrome DevTools Protocol, without VS Code: the Dragonfly devices (mobile and web) drive a
// headless browser with it (screencast, input, emulation, console, network).
import * as net from 'node:net';

const HOST = '127.0.0.1';

// VS Code's Node (24) has a global WebSocket; the project's Node types predate it.
interface Ws {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((m: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}
const WebSocketImpl = (globalThis as unknown as { WebSocket: new (url: string) => Ws }).WebSocket;

/** A small CDP client over the WebSocket of one page. */
export class Cdp {
  private id = 0;
  private readonly pending = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();
  private readonly listeners = new Map<string, (params: Record<string, unknown>) => void>();
  private constructor(private readonly ws: Ws) {
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data));
      if (d.id !== undefined) {
        this.pending.get(d.id)?.(d);
        this.pending.delete(d.id);
      } else if (d.method) this.listeners.get(d.method)?.(d.params);
    };
  }

  static open(url: string): Promise<Cdp> {
    return new Promise((done, fail) => {
      const ws = new WebSocketImpl(url);
      ws.onopen = () => done(new Cdp(ws));
      ws.onerror = () => fail(new Error(`cannot connect to ${url}`));
    });
  }

  call<T = unknown>(method: string, params: object = {}): Promise<T> {
    return new Promise((done, fail) => {
      const id = ++this.id;
      this.pending.set(id, (r) => (r.error ? fail(new Error(r.error.message)) : done(r.result as T)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event: string, f: (params: Record<string, unknown>) => void): void {
    this.listeners.set(event, f);
  }

  set onclose(f: () => void) {
    this.ws.onclose = f;
  }

  close(): void {
    this.ws.close();
  }
}

/** The browser's page, once Flutter started the browser (polls its target list; the first web build takes a
 * while). Flutter opens it on an empty page (see `launchProvider`). */
export async function browserPage(cdpPort: number, tries = 600): Promise<Cdp> {
  for (let i = 0; i < tries; i++) {
    try {
      const targets = (await (await fetch(`http://${HOST}:${cdpPort}/json/list`)).json()) as {
        type: string;
        url: string;
        webSocketDebuggerUrl: string;
      }[];
      const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('chrome'));
      if (page) return await Cdp.open(page.webSocketDebuggerUrl);
    } catch {
      // the browser is still starting
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('the browser did not open the app');
}


export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const s = net.createServer();
    s.on('error', fail);
    s.listen(0, HOST, () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => done(port));
    });
  });
}
