// The right-click menu of the Nuclear workspace file tree. Each row carries `data-vscode-context` (the host
// computes it here from the clicked path and the platform's layout, `nuclear help layout`), and package.json
// shows an item in `webview/context` only when its id is in `nuclearMake` / its flag is true: a config file gets no
// "new project", a usecases folder gets only "new use case", build/ gets nothing.

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';

interface Make {
  /** Where the kind's files go, relative to the project root; `{c}` component, `{s}` screen. */
  dir: string;
  /** The arguments of `dragonfly` for a (component, screen, name). */
  args: (c: string, s: string, n: string) => string[];
}

const generic = (kind: string) => (c: string, s: string, n: string) => ['make', kind, c, n, ...(s ? ['--screen', s] : [])];
const named = (kind: string) => (c: string, _s: string, n: string) => ['make', kind, c, n];
const screened = (kind: string) => (c: string, s: string, n: string) => ['make', kind, c, s, n];
const shared = (kind: string) => (_c: string, _s: string, n: string) => ['make', kind, n];
const C = (dir: string) => `components/{c}/${dir}`;

/** What each platform can make and where (dragonfly help, `nuclear help layout --platform <p>`). */
const MAKES: Record<string, Record<string, Make>> = {
  backend: Object.fromEntries(
    Object.entries({ usecase: 'domain/usecases', model: 'domain/models', service: 'domain/services', aggregate: 'domain/aggregates', repository: 'data/repositories', entity: 'data/entities', controller: 'api', listener: 'events', agent: 'ai', graph: 'ai', tools: 'ai', state: 'ai/states' }).map(([k, d]) => [k, { dir: C(d), args: generic(k) }]),
  ),
  web: Object.fromEntries(
    Object.entries({ usecase: 'domain/usecases', model: 'domain/models', service: 'domain/services', repository: 'data', stateful: 'presentation/{s}', stateless: 'presentation/{s}', statemodel: 'presentation/{s}/state_models' }).map(([k, d]) => [k, { dir: C(d), args: generic(k) }]),
  ),
  mobile: {
    usecase: { dir: C('domain/usecases'), args: named('usecase') },
    model: { dir: C('domain/models'), args: named('model') },
    service: { dir: C('domain/services'), args: named('service') },
    aggregate: { dir: C('domain/aggregates'), args: named('aggregate') },
    repository: { dir: C('data'), args: named('repository') },
    statemanager: { dir: C('presentation/{s}/managers'), args: screened('statemanager') },
    statemodel: { dir: C('presentation/{s}/state_models'), args: screened('statemodel') },
    widget: { dir: 'shared/widgets', args: shared('widget') },
    guard: { dir: 'shared/guards', args: shared('guard') },
    event: { dir: 'shared/events', args: shared('event') },
    global: { dir: 'shared/components', args: shared('global') },
    page: { dir: 'shared/screens', args: shared('page') },
    integration: { dir: 'integration_test', args: shared('integration') },
  },
};

/** The command line of a make id (also the ids that are not a kind: component, screen, config, test, resource). */
export function makeArgs(platform: string, id: string, c: string, s: string, n: string, fields = ''): string[] | undefined {
  if (id === 'component') return platform === 'mobile' ? ['make', 'component', n] : ['make', 'appcomponent', n, n];
  if (id === 'screen') return ['make', 'screen', c, n];
  if (id === 'test') return platform === 'mobile' ? ['make', 'test', c] : ['make', 'tests', c, c];
  if (id === 'resource') return ['gen', 'resource', c, n, ...(fields ? ['--fields', fields] : [])];
  if (id === 'config') return platform === 'mobile' ? ['make', 'config', c] : ['make', 'config', c, c];
  return MAKES[platform]?.[id]?.args(c, s, n);
}

/** Folders the user must not touch: generated or installed. */
const GENERATED = new Set(['build', 'node_modules', '.dart_tool', '.git']);
/** What keeps a project a project. */
const PROTECTED = new Set(['config.nuc', 'main.nuc', 'nuclear.toml', 'config/project_config.nuc']);

export function contextFor(platform: string | null | undefined, root: string, full: string, isDir: boolean): Record<string, unknown> {
  const rel = path.relative(root, full).split(path.sep).filter(Boolean);
  const base = { webviewSection: 'file', nuclearPath: full, nuclearRoot: root, nuclearPlatform: platform ?? '', preventDefaultContextMenuItems: true };
  if (GENERATED.has(rel[0] ?? '')) return base;
  const isRoot = rel.length === 0;
  const flags = { nuclearNew: isDir, nuclearEdit: !isRoot && !PROTECTED.has(rel.join('/')), nuclearDel: !isRoot && !PROTECTED.has(rel.join('/')) };
  if (!isDir || !platform || !MAKES[platform]) return { ...base, ...flags };
  const c = rel[0] === 'components' ? (rel[1] ?? '') : '';
  const s = platform !== 'backend' && c && rel[2] === 'presentation' ? (rel[3] ?? '') : '';
  const ids: string[] = [];
  for (const [id, m] of Object.entries(MAKES[platform])) {
    const target = m.dir.split('/');
    if (target.includes('{c}') && !c) continue;
    if (target.includes('{s}') && !s) continue; // a screen's kinds need a screen folder
    const want = target.map((t) => (t === '{c}' ? c : t === '{s}' ? s : t));
    // the clicked folder is the kind's folder or one of its parents
    if (!isRoot && rel.every((seg, i) => want[i] === seg)) ids.push(id);
  }
  if (isRoot || (rel.length === 1 && rel[0] === 'components')) ids.push('component');
  if (c && rel.length === 2) ids.push('test');
  if (c && rel.length === 2 && platform === 'backend') ids.push('resource'); // gen resource defaults to a db: only a backend has one
  if (platform === 'mobile' && c && (rel.length === 2 || (rel.length === 3 && rel[2] === 'presentation'))) ids.push('screen');
  if (platform !== 'web' && c && rel.length === 2) ids.push('config');
  return { ...base, ...flags, nuclearC: c, nuclearS: s, nuclearMake: ' ' + ids.join(' ') + ' ' };
}

/** Every make id the menu can show (package.json has one command and one item per id). */
export const MAKE_IDS = [...new Set([...Object.values(MAKES).flatMap((m) => Object.keys(m)), 'component', 'screen', 'config', 'test', 'resource'])];

interface Ctx {
  nuclearPath: string;
  nuclearRoot: string;
  nuclearPlatform: string;
  nuclearC?: string;
  nuclearS?: string;
}

const run = (cwd: string, args: string[]) =>
  new Promise<{ ok: boolean; out: string }>((resolve) =>
    execFile('dragonfly', args, { cwd }, (err, stdout, stderr) => resolve({ ok: !err, out: (stdout + stderr).trim() })),
  );

async function make(id: string, x: Ctx): Promise<void> {
  const needsName = id !== 'test' && id !== 'config';
  const name = needsName ? await vscode.window.showInputBox({ prompt: `Name of the new ${id}`, validateInput: (v) => (/^[A-Za-z][A-Za-z0-9_]*$/.test(v) ? undefined : 'letters, digits and _, starting with a letter') }) : '';
  if (needsName && !name) return;
  const fields = id === 'resource' ? await vscode.window.showInputBox({ prompt: 'Fields (optional): id:int title:string origin:Origin?', value: 'id:int name:string' }) : '';
  if (fields === undefined) return;
  const args = makeArgs(x.nuclearPlatform, id, x.nuclearC ?? '', x.nuclearS ?? '', name ?? '', fields);
  if (!args) return;
  const r = await run(x.nuclearRoot, args);
  if (!r.ok) return void vscode.window.showErrorMessage(`dragonfly ${args.join(' ')}: ${r.out}`);
  const created = /created\s+(\S+\.nuc)/.exec(r.out)?.[1];
  if (created) void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(x.nuclearRoot, created)));
  else void vscode.window.showInformationMessage(r.out || 'Nothing to create.');
}

export function registerTreeCommands(context: vscode.ExtensionContext): void {
  const reg = (id: string, fn: (x: Ctx) => Promise<void>) => context.subscriptions.push(vscode.commands.registerCommand(id, (x?: Ctx) => (x?.nuclearPath ? fn(x) : undefined)));
  for (const id of MAKE_IDS) reg(`nuclear.tree.make.${id}`, (x) => make(id, x));
  const create = (folder: boolean) => async (x: Ctx) => {
    const name = await vscode.window.showInputBox({ prompt: folder ? 'New folder' : 'New file' });
    if (!name) return;
    const uri = vscode.Uri.file(path.join(x.nuclearPath, name));
    if (folder) await vscode.workspace.fs.createDirectory(uri);
    else {
      await vscode.workspace.fs.writeFile(uri, new Uint8Array());
      void vscode.commands.executeCommand('vscode.open', uri);
    }
  };
  reg('nuclear.tree.newFile', create(false));
  reg('nuclear.tree.newFolder', create(true));
  reg('nuclear.tree.rename', async (x) => {
    const old = path.basename(x.nuclearPath);
    const name = await vscode.window.showInputBox({ prompt: `Rename ${old}`, value: old });
    if (name && name !== old) await vscode.workspace.fs.rename(vscode.Uri.file(x.nuclearPath), vscode.Uri.file(path.join(path.dirname(x.nuclearPath), name)));
  });
  reg('nuclear.tree.delete', async (x) => {
    const ok = await vscode.window.showWarningMessage(`Move ${path.basename(x.nuclearPath)} to the trash?`, { modal: true, detail: x.nuclearPath }, 'Move to trash');
    if (ok) await vscode.workspace.fs.delete(vscode.Uri.file(x.nuclearPath), { recursive: true, useTrash: true });
  });
}
