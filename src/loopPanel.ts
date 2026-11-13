// The Loop tool (ADR-0102): one full-screen page, like Devices and HTTP. On the left the runs of the active project;
// in the middle either the spec form (the start of every piece of work: the use case, the spec written here or
// imported from Jira or GitHub, the context the agents get, who leads) or a run drawn as a graph: a column per stage,
// a node per step in the order it ran and, under each step, the steps its agent followed. A click on a node opens it
// beside the graph: what it did, the decisions it took and why, its input, its output and its code. Any step can be
// run again (passed or failed), and the whole run from scratch. The engine (loopEngine.ts) does the work; this file
// only draws it and passes the user's choices. Plain HTML and script, no framework.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { jiraAuth, machineConfig } from './aiSettings';
import { notices } from './notifications';
import { readCard } from './card';
import { CiProvider, ciFile, githubIssue, jiraIssue, JiraAuth, jiraMine, listRuns, LoopEngine, newRun, Piece, readConfig, recoverRuns, Run, slug, Spec, StageId, suggestContext, writeConfig, CONFIG_FILE } from './loopEngine';

export interface LoopProject {
  root: string;
  name: string;
  platform?: string | null;
}

type Message =
  | { type: 'ready' }
  | { type: 'project'; root: string }
  | { type: 'suggest'; text: string }
  | { type: 'jira'; key: string }
  | { type: 'jiraMine' }
  | { type: 'jiraSetup' }
  | { type: 'github'; ref: string }
  | { type: 'plan'; spec: Spec }
  | { type: 'start'; spec: Spec }
  | { type: 'stop'; id: string }
  | { type: 'retry'; id: string; step?: boolean | string; stage?: StageId; scratch?: boolean }
  | { type: 'open'; file: string }
  | { type: 'exportCi'; provider: CiProvider }
  | { type: 'config' };


/** The runs going on, by id: they outlive the page (a closed page or another tool does not stop them). */
const engines = new Map<string, LoopEngine>();

/** Runs (or retries) a run. The engine belongs to the extension, not to a page: closing the page or switching tools
 * leaves it running; whatever page is open draws it, and a notification says how it ended. */
export async function driveRun(root: string, run: Run, go: (engine: LoopEngine) => Promise<Run>): Promise<void> {
  if (engines.has(run.id)) return;
  const engine = new LoopEngine(run, readConfig(root, readCard(root)?.platform ?? '', machineConfig()));
  engines.set(run.id, engine);
  let last = 0;
  engine.on('change', (r) => {
    // a command's output arrives in many small pieces: at most ten frames a second
    const now = Date.now();
    if (now - last < 100 && r.status === 'running') return;
    last = now;
    LoopPanel.refreshRun(r);
  });
  try {
    await go(engine);
  } catch (e) {
    notices.add({ tool: 'loop', title: `Loop "${run.spec.title}" did not start`, text: e instanceof Error ? e.message : String(e), level: 'error', root, ref: run.id });
    return;
  } finally {
    engines.delete(run.id);
    LoopPanel.refreshRun(engine.run);
  }
  const r = engine.run;
  const failed = r.stages.flatMap((st) => st.steps).reverse().find((s) => s.status === 'failed');
  notices.add({
    tool: 'loop',
    title: r.status === 'passed' ? `Loop "${r.spec.title}" passed` : `Loop "${r.spec.title}" ${r.status}`,
    text: r.status === 'passed' ? 'every stage passed' : failed ? `${failed.title}: ${failed.summary}` : 'stopped',
    level: r.status === 'passed' ? 'info' : 'error',
    root,
    ref: r.id,
  });
}

/** The runs a closed or crashed editor left running: each is recovered (its unfinished steps failed, what they wrote
 * undone) and, unless `nuclear.ai.resumeInterrupted` is off, goes on from the step where it stopped. */
export function resumeOrphans(roots: string[]): void {
  const resume = vscode.workspace.getConfiguration('nuclear.ai').get('resumeInterrupted', true);
  for (const root of roots) {
    for (const run of recoverRuns(root)) {
      const at = run.interrupted?.at(-1);
      const where = at ? `${at.stage}${at.step ? ` · ${at.step}` : ''}` : 'a step';
      notices.add({ tool: 'loop', title: `Loop "${run.spec.title}" was interrupted`, text: resume ? `at ${where}: it goes on from there` : `at ${where}: Retry to go on`, level: 'warning', root, ref: run.id });
      if (resume) void driveRun(root, run, (e) => e.start(undefined, true));
    }
  }
}

export class LoopPanel {
  private static current: LoopPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private root = '';
  private disposed = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly projects: () => LoopProject[],
  ) {
    this.panel = vscode.window.createWebviewPanel('nuclear.loop', 'Loop', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'icons', 'nuc-file.svg');
    this.panel.webview.html = html(this.panel.webview);
    this.panel.onDidDispose(() => {
      this.disposed = true;
      LoopPanel.current = undefined;
      notices.watch('loop', false);
    });
    this.panel.onDidChangeViewState((e) => notices.watch('loop', e.webviewPanel.visible && e.webviewPanel.active));
    this.panel.webview.onDidReceiveMessage((m: Message) => void this.receive(m).catch((e) => this.post({ type: 'error', text: String(e instanceof Error ? e.message : e) })));
  }

  /** The Loop page, created or revealed, on the active project (or the first one). */
  static show(context: vscode.ExtensionContext, projects: () => LoopProject[], active?: string, run?: string): void {
    const p = LoopPanel.current ?? (LoopPanel.current = new LoopPanel(context, projects));
    if (active && projects().some((x) => x.root === active)) p.root = active;
    p.panel.reveal(vscode.ViewColumn.Active);
    notices.watch('loop', true);
    p.state();
    const r = run ? listRuns(p.root).find((x) => x.id === run) : undefined;
    if (r) p.post({ type: 'run', run: r, select: true });
  }

  static close(): void {
    LoopPanel.current?.panel.dispose();
  }

  /** Draws a run that changed on the open page (nothing when it is closed). */
  static refreshRun(run: Run): void {
    LoopPanel.current?.post({ type: 'run', run });
    if (run.status !== 'running') LoopPanel.current?.state();
  }

  private post(m: unknown): void {
    if (!this.disposed) void this.panel.webview.postMessage(m);
  }

  private state(): void {
    const projects = this.projects();
    if (!projects.some((p) => p.root === this.root)) this.root = projects[0]?.root ?? '';
    const card = this.root ? readCard(this.root) : undefined;
    const config = this.root ? readConfig(this.root, card?.platform ?? '', machineConfig()) : undefined;
    this.post({
      type: 'state',
      projects: projects.map((p) => ({ root: p.root, name: p.name, platform: p.platform ?? '' })),
      root: this.root,
      card: card ? { name: card.name, platform: card.platform, dialect: card.dialect } : null,
      runs: this.root ? listRuns(this.root) : [],
      running: [...engines.keys()],
      config,
    });
  }

  private jiraAuth(ask: boolean): Promise<JiraAuth | undefined> {
    return jiraAuth(this.context, ask);
  }

  private async receive(m: Message): Promise<void> {
    switch (m.type) {
      case 'ready':
        return this.state();
      case 'project':
        this.root = m.root;
        return this.state();
      case 'suggest':
        return this.post({ type: 'suggestions', list: this.root ? suggestContext(this.root, m.text) : [] });
      case 'jiraSetup':
        await this.jiraAuth(true);
        return this.post({ type: 'info', text: 'Jira connected.' });
      case 'jira': {
        const auth = await this.jiraAuth(false);
        if (auth) this.post({ type: 'issue', issue: await jiraIssue(auth, m.key.trim().toUpperCase()), source: 'jira' });
        return;
      }
      case 'jiraMine': {
        const auth = await this.jiraAuth(false);
        if (auth) this.post({ type: 'mine', issues: await jiraMine(auth) });
        return;
      }
      case 'github':
        return this.post({ type: 'issue', issue: await githubIssue(this.root, m.ref.trim()), source: 'github' });
      case 'plan': {
        const config = readConfig(this.root, readCard(this.root)?.platform ?? '', machineConfig());
        const r = await fetch(config.developerUrl + '/developer/plan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ spec: `# ${m.spec.title}\n\n${m.spec.description}\n\n${m.spec.criteria.map((c) => `- ${c}`).join('\n')}`, dialect: readCard(this.root)?.dialect ?? 'fastapi' }) }).catch((e) => {
          throw new Error(`the local developer is not running at ${config.developerUrl} (${String(e)})`);
        });
        const data = (await r.json()) as { pieces: Piece[] };
        return this.post({ type: 'pieces', pieces: data.pieces ?? [] });
      }
      case 'start':
        return this.start(m.spec);
      case 'stop':
        engines.get(m.id)?.stop();
        return;
      case 'retry': {
        const run = listRuns(this.root).find((r) => r.id === m.id);
        if (!run || engines.has(m.id)) return;
        if (m.scratch) {
          // it undoes files: said before it is done (a file changed since the run wrote it is kept either way)
          const files = [...new Set((run.writes ?? []).map((w) => w.path))];
          const go = await vscode.window.showWarningMessage(`Run "${run.spec.title}" again from scratch?`, { modal: true, detail: `Every stage runs again from the specification. ${files.length ? `The ${files.length} file(s) this run wrote go back to what they were first (${files.slice(0, 6).join(', ')}${files.length > 6 ? '…' : ''}); a file you changed since is kept.` : 'This run wrote no file.'} The attempt that ends here stays in the run's history.` }, 'Run from scratch');
          if (go !== 'Run from scratch') return;
          return this.drive(run, (e) => e.restart());
        }
        return this.drive(run, (e) => e.start(m.stage, m.step ?? false));
      }
      case 'open': {
        const file = path.isAbsolute(m.file) ? m.file : path.join(this.root, m.file);
        if (fs.existsSync(file)) await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside, preview: true });
        return;
      }
      case 'config': {
        const file = path.join(this.root, CONFIG_FILE);
        if (!fs.existsSync(file)) writeConfig(this.root, readConfig(this.root, readCard(this.root)?.platform ?? ''));
        await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside });
        return;
      }
      case 'exportCi': {
        const card = readCard(this.root);
        const out = ciFile(m.provider, readConfig(this.root, card?.platform ?? '', machineConfig()), card?.platform ?? '');
        const file = path.join(this.root, out.path);
        if (fs.existsSync(file)) {
          const ok = await vscode.window.showWarningMessage(`${out.path} exists. Replace it?`, { modal: true }, 'Replace');
          if (ok !== 'Replace') return;
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, out.text);
        await vscode.window.showTextDocument(vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.Beside });
        return;
      }
    }
  }

  private async start(spec: Spec): Promise<void> {
    const card = readCard(this.root);
    if (!card) throw new Error('the project has no card yet (.nuclear/project.json): build it once (nuclear build . or dragonfly build)');
    const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${slug(spec.title)}`;
    let unique = id;
    for (let n = 2; fs.existsSync(path.join(this.root, '.nuclear', 'loop', 'runs', `${unique}.json`)); n++) unique = `${id}-${n}`;
    return this.drive(newRun(this.root, card, { ...spec, id: unique }), (e) => e.start());
  }

  /** Runs (or retries, from its first failed stage) a run, drawing it as it changes. */
  private drive(run: Run, go: (engine: LoopEngine) => Promise<Run>): Promise<void> {
    this.post({ type: 'run', run, select: true });
    return driveRun(this.root, run, go);
  }

}

function html(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${CSS}</style></head><body>
<header>
  <div class="brand"><svg viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 1 0 6.3 8"/><path d="M14.5 4.5v4h-4"/></svg><b>Loop</b><span class="muted">spec → generate → plan → tests → code → verify → security → artifacts → deploy</span></div>
  <select id="project" title="Project"></select>
  <div class="grow"></div>
  <button id="new" class="primary">＋ New spec</button>
  <div class="menu"><button id="ci">Export CI ▾</button><div class="pop" id="ciPop"><a data-ci="github">GitHub Actions</a><a data-ci="gitlab">GitLab CI</a><a data-ci="bitbucket">Bitbucket Pipelines</a></div></div>
  <button id="config" title="The commands of each stage (.nuclear/loop.json)">Pipeline settings</button>
</header>
<div class="body">
  <aside><div class="aside-title">Runs</div><div id="runs"></div><div class="legend" id="legend"></div></aside>
  <main id="main"></main>
</div>
<div id="toast"></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body></html>`;
}

const CSS = `
:root { --bg: var(--vscode-editor-background); --fg: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground);
  --line: var(--vscode-panel-border, #8884); --card: var(--vscode-sideBar-background, #8881); --accent: var(--vscode-focusBorder, #3b82f6);
  --ok: var(--vscode-testing-iconPassed, #3fb950); --bad: var(--vscode-testing-iconFailed, #f85149); --run: var(--vscode-charts-yellow, #d29922);
  --skip: var(--vscode-disabledForeground, #8b949e); }
* { box-sizing: border-box; }
body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 var(--vscode-font-family); height: 100vh; overflow: hidden; }
button, select, input, textarea { font: inherit; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--line)); border-radius: 4px; padding: 5px 9px; }
button { cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; }
button:hover { filter: brightness(1.15); }
button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
button:focus-visible, a:focus-visible, .gnode:focus-visible, .card:focus-visible, .accept:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
textarea { width: 100%; resize: vertical; }
header { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--line); height: 46px; }
.brand { display: flex; align-items: center; gap: 8px; }
.brand svg { width: 18px; height: 18px; fill: none; stroke: var(--accent); stroke-width: 1.6; }
.brand b { font-size: 15px; }
.muted { color: var(--muted); }
.grow { flex: 1; }
.menu { position: relative; }
.pop { display: none; position: absolute; right: 0; top: 32px; background: var(--vscode-menu-background, var(--card)); border: 1px solid var(--line); border-radius: 6px; z-index: 5; min-width: 180px; }
.pop.open { display: block; }
.pop a { display: block; padding: 7px 12px; cursor: pointer; }
.pop a:hover { background: var(--vscode-list-hoverBackground); }
.body { display: flex; height: calc(100vh - 46px); }
aside { width: 260px; border-right: 1px solid var(--line); overflow: auto; padding: 10px; flex-shrink: 0; display: flex; flex-direction: column; }
.aside-title { text-transform: uppercase; font-size: 11px; letter-spacing: .06em; color: var(--muted); margin: 4px 4px 8px; }
.run-item { padding: 8px; border-radius: 6px; cursor: pointer; display: grid; grid-template-columns: 14px 1fr; gap: 6px; align-items: start; }
.run-item:hover { background: var(--vscode-list-hoverBackground); }
.run-item.sel { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.run-item small { display: block; color: var(--muted); }
.legend { margin-top: auto; border-top: 1px solid var(--line); padding-top: 10px; display: grid; gap: 4px; }
.legend div { display: flex; gap: 6px; align-items: center; font-size: 12px; }
main { flex: 1; overflow: auto; position: relative; min-width: 0; }
.dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; margin-top: 4px; background: var(--skip); }
.st-passed { background: var(--ok); } .st-failed { background: var(--bad); } .st-running { background: var(--run); animation: pulse 1.2s infinite; } .st-skipped { background: transparent; border: 1.5px solid var(--skip); }
@keyframes pulse { 50% { opacity: .35; } }
.av { width: 20px; height: 20px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 700; color: #fff; flex-shrink: 0; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px 2px 2px; border-radius: 12px; background: var(--card); border: 1px solid var(--line); font-size: 11.5px; }
/* the form */
.form { max-width: 980px; margin: 0 auto; padding: 22px 26px 60px; }
.form h1 { font-size: 20px; margin: 0 0 4px; }
.section { display: grid; grid-template-columns: 34px 1fr; gap: 14px; margin-top: 26px; }
.num { width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--accent); display: flex; align-items: center; justify-content: center; font-weight: 700; color: var(--accent); }
.section h2 { font-size: 14px; margin: 3px 0 10px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(165px, 1fr)); gap: 10px; }
.card { border: 1px solid var(--line); border-radius: 8px; padding: 11px; cursor: pointer; background: var(--card); }
.card:hover { border-color: var(--accent); }
.card.sel { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.card b { display: block; margin: 4px 0 2px; } .card span { color: var(--muted); font-size: 12px; }
.card .ico { font-size: 18px; }
.tabs { display: flex; gap: 4px; margin-bottom: 10px; }
.tabs button.sel { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.row input { flex: 1; }
label.f { display: block; font-size: 12px; color: var(--muted); margin: 10px 0 4px; }
.crit { display: flex; gap: 6px; margin-bottom: 6px; } .crit input { flex: 1; }
.sug { display: grid; grid-template-columns: 18px 1fr auto; gap: 8px; padding: 5px 6px; border-radius: 4px; align-items: center; }
.sug:hover { background: var(--vscode-list-hoverBackground); }
.kind { font-size: 10.5px; text-transform: uppercase; color: var(--muted); }
.lead { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.lead .card ul { margin: 6px 0 0 16px; padding: 0; color: var(--muted); font-size: 12px; }
table.pieces { width: 100%; border-collapse: collapse; margin-top: 8px; } table.pieces td { border-top: 1px solid var(--line); padding: 4px; } table.pieces input { width: 100%; }
.go { margin-top: 28px; display: flex; gap: 10px; justify-content: flex-end; }
/* the run: its graph and the node that is open */
main.run { overflow: hidden; display: flex; flex-direction: column; }
.top { padding: 14px 22px 8px; flex-shrink: 0; }
.head { display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
.head h1 { font-size: 19px; margin: 0; }
.hint { margin-top: 6px; } .hint a { cursor: pointer; color: var(--vscode-textLink-foreground); }
.diagnosis { margin: 8px 0; padding: 8px 12px; border-left: 3px solid #d97706; background: var(--vscode-textCodeBlock-background); }
.diagnosis pre { white-space: pre-wrap; margin: 6px 0 0; max-height: 22vh; font-family: var(--vscode-editor-font-family); }
.accept { margin: 8px 0 0; padding: 6px 12px; border-left: 3px solid var(--ok); background: var(--vscode-textCodeBlock-background); cursor: pointer; }
.accept.warn { border-left-color: var(--run); } .accept.bad { border-left-color: var(--bad); }
.pill { padding: 2px 9px; border-radius: 10px; font-size: 11.5px; border: 1px solid var(--line); white-space: nowrap; }
.split { flex: 1; min-height: 0; display: flex; border-top: 1px solid var(--line); }
.graph { flex: 1 1 56%; overflow: auto; padding: 18px 22px; }
.canvas { position: relative; }
.canvas svg { position: absolute; left: 0; top: 0; pointer-events: none; }
.canvas svg path { fill: none; stroke: var(--line); stroke-width: 1.5; }
.canvas svg path.arrow { marker-end: url(#ah); }
.canvas svg path.flow { stroke: var(--run); stroke-dasharray: 6 6; animation: dash .6s linear infinite; }
.canvas svg marker path { fill: var(--skip); stroke: none; }
@keyframes dash { to { stroke-dashoffset: -12; } }
.gnode { position: absolute; border: 1px solid var(--line); border-radius: 8px; background: var(--card); cursor: pointer; overflow: hidden; }
.gnode:hover { border-color: var(--accent); }
.gnode.sel { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent); }
.gnode.running { border-color: var(--run); } .gnode.failed { border-color: var(--bad); }
.gnode.passed { border-color: color-mix(in srgb, var(--ok) 55%, var(--line)); }
.gstage { padding: 8px 11px; border-radius: 10px; }
.gstage .n { font-size: 11px; color: var(--muted); white-space: nowrap; }
.gstage .t { display: flex; gap: 7px; align-items: center; font-weight: 600; white-space: nowrap; }
.gstage .t .dot { margin-top: 0; }
.gstep { display: grid; grid-template-columns: 20px 1fr auto; gap: 7px; align-items: center; padding: 5px 8px; }
.gt { min-width: 0; } .gt b, .gt small { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.gt b { font-weight: 600; font-size: 12px; } .gt small { color: var(--muted); font-size: 11px; }
.gm { display: grid; justify-items: end; font-size: 10.5px; color: var(--muted); white-space: nowrap; }
.dec { color: var(--accent); }
.gsub { padding: 2px 8px; font-size: 11px; line-height: 18px; white-space: nowrap; text-overflow: ellipsis; border-radius: 6px; color: var(--muted); }
.gsub b { text-transform: uppercase; font-size: 10px; color: var(--fg); }
.drawer { flex: 1 1 44%; min-width: 340px; max-width: 760px; overflow: auto; border-left: 1px solid var(--line); padding: 14px 18px 60px; }
.drawer h2 { font-size: 16px; margin: 0; overflow-wrap: anywhere; }
.drawer h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); margin: 18px 0 8px; }
.dhead { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 4px; }
.sum { margin: 8px 0; overflow-wrap: anywhere; }
.acts { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0; }
.block { display: block; }
.who { display: grid; gap: 10px; } .who > div { display: grid; grid-template-columns: 22px 1fr; gap: 8px; align-items: start; }
.who small { color: var(--muted); display: block; }
.crow { display: grid; grid-template-columns: 16px 1fr; gap: 8px; align-items: start; padding: 4px 0; }
.crow small { display: block; color: var(--muted); overflow-wrap: anywhere; } .crow .dot { margin-top: 5px; }
.crow.link { cursor: pointer; border-radius: 4px; } .crow.link:hover { background: var(--vscode-list-hoverBackground); }
.okc { color: var(--ok); } .badc { color: var(--run); }
.flow-n { display: grid; grid-template-columns: 22px 1fr; gap: 9px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; background: var(--card); overflow-wrap: anywhere; }
.flow-n.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.flow-n b { text-transform: uppercase; font-size: 11px; color: var(--muted); }
.flow-a { color: var(--muted); padding-left: 16px; line-height: 16px; }
.num2 { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--accent); color: var(--accent); font-size: 11px; font-weight: 700; display: flex; align-items: center; justify-content: center; }
.decn { display: grid; grid-template-columns: 16px 1fr; gap: 8px; padding: 6px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }
.decn > span { color: var(--accent); }
.drawer a { cursor: pointer; color: var(--vscode-textLink-foreground); }
@media (prefers-reduced-motion: reduce) { .st-running, .canvas svg path.flow { animation: none; } }
pre { background: var(--vscode-textCodeBlock-background, #0002); padding: 10px; border-radius: 6px; overflow: auto; max-height: 52vh; white-space: pre-wrap; font: 12px/1.45 var(--vscode-editor-font-family); margin: 0; }
.dtabs { display: flex; gap: 4px; margin: 10px 0; }
.dtabs button.sel { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.empty { padding: 60px; text-align: center; color: var(--muted); }
#toast { position: fixed; bottom: 16px; right: 16px; padding: 10px 14px; border-radius: 6px; background: var(--vscode-notifications-background, var(--card)); border: 1px solid var(--line); display: none; max-width: 480px; z-index: 9; }
#toast.err { border-color: var(--bad); }
`;

const SCRIPT = String.raw`
const vscode = acquireVsCodeApi();
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ACTORS = {
  you: { name: 'You', color: '#6b7280', letter: 'Y', does: 'Write the spec, choose its context and who leads, read the result.', not: 'Never write a piece here.' },
  claude: { name: 'Claude', color: '#c96442', letter: 'C', does: 'Plans the pieces, fixes what the local coder could not, reviews, teaches the graph.', not: 'Does not write every piece: the local coder does.' },
  planner: { name: 'Planner · gemma4:e2b', color: '#7c3aed', letter: 'P', does: 'Splits a spec into pieces when no frontier model leads.', not: 'No architecture decisions beyond the platform\'s structure.' },
  coder: { name: 'Coder · qwen2.5-coder:3b', color: '#2563eb', letter: 'Co', does: 'Writes one file at a time with the Smart Graph and repairs it with the compiler.', not: 'Does not choose names, data or architecture.' },
  tester: { name: 'Tester · local', color: '#0891b2', letter: 'T', does: 'Writes the Nuclear tests of the new code.', not: 'Never deletes a test that fails.' },
  security: { name: 'Security · local', color: '#b91c1c', letter: 'S', does: 'Reviews each new file against the platform\'s security rules.', not: 'Reports; does not change the code.' },
  diagnoser: { name: 'Diagnoser · local', color: '#d97706', letter: 'D', does: 'When a stage fails: the kind of failure (by rules), the evidence (compiler, doctor) and what to do next.', not: 'Changes nothing; you retry.' },
  shell: { name: 'Shell', color: '#4b5563', letter: '$', does: 'Runs the project\'s commands of .nuclear/loop.json: the same ones the exported CI runs.', not: 'Nothing it was not told to run.' },
  graph: { name: 'Smart Graph', color: '#16a34a', letter: 'G', does: 'Answers what the agents search; keeps what Claude teaches.', not: 'Readable only by the clients you allowed.' },
};
const USE_CASES = [
  ['feature', '✦', 'New feature', 'Something the app cannot do yet'],
  ['refactor', '⟲', 'Refactor', 'Change the structure, not the behaviour'],
  ['bug', '⚑', 'Diagnose a bug', 'Reproduce, find the cause, fix it once'],
  ['test', '✓', 'Tests', 'Cover what is not covered'],
  ['security', '⛨', 'Security review', 'Find what an attacker could do'],
  ['docs', '¶', 'Documentation', 'A page for a developer who is new here'],
  ['diagram', '◫', 'Diagram', 'C4 context, containers, components'],
];
const TEMPLATES = {
  feature: 'As a <user> I want <capability> so that <value>.\n\nAcceptance criteria:\n- ',
  refactor: 'Move/rename/split <what> because <why>. Nothing changes for the users of the app.\n\nAcceptance criteria:\n- every existing test still passes\n- ',
  bug: 'Steps: \nExpected: \nActual: \n\nAcceptance criteria:\n- a test reproduces the bug and passes after the fix\n- ',
  test: 'Cover <component or use case>: its normal case, its edge cases and its errors.\n\nAcceptance criteria:\n- ',
  security: 'Review <component or routes> for input validation, authorization, secrets and leaked errors.\n\nAcceptance criteria:\n- no high finding is left\n- ',
  docs: 'Document <part> for a developer who knows the domain but not this code.\n\nAcceptance criteria:\n- every Nuclear example passes nuclear check\n- ',
  diagram: 'Draw <part> as C4 diagrams (context, containers, components) in Mermaid.\n\nAcceptance criteria:\n- ',
};
let S = { projects: [], root: '', card: null, runs: [], running: [], config: null };
// auto: nothing was chosen, so the drawer follows the run (the step running, else the one that failed)
let view = { mode: 'form', run: null, stage: null, step: null, trace: null, tab: 'trace', auto: true };
let form = blank();
function blank() { return { useCase: 'feature', title: '', description: TEMPLATES.feature, criteria: [''], context: [], source: { kind: 'local' }, lead: 'claude', pieces: [], suggestions: [], srcTab: 'write', mine: [] }; }
const av = (a) => '<span class="av" style="background:' + ACTORS[a].color + '" title="' + esc(ACTORS[a].name) + '">' + ACTORS[a].letter + '</span>';
const dur = (s) => { if (!s?.started) return ''; const ms = (s.ended ?? Date.now()) - s.started; return ms < 1000 ? ms + ' ms' : ms < 60000 ? (ms / 1000).toFixed(1) + ' s' : Math.floor(ms / 60000) + ' min ' + Math.round((ms % 60000) / 1000) + ' s'; };
function toast(text, err) { const t = $('#toast'); t.textContent = text; t.className = err ? 'err' : ''; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => (t.style.display = 'none'), 6000); }

// ---------- chrome ----------
function drawChrome() {
  $('#project').innerHTML = S.projects.map((p) => '<option value="' + esc(p.root) + '"' + (p.root === S.root ? ' selected' : '') + '>' + esc(p.name) + (p.platform ? ' · ' + esc(p.platform) : '') + '</option>').join('') || '<option>No project: open one in the Nuclear workspace</option>';
  $('#runs').innerHTML = S.runs.length ? S.runs.map((r) => '<div class="run-item' + (view.run?.id === r.id ? ' sel' : '') + '" data-run="' + esc(r.id) + '" tabindex="0"><span class="dot st-' + r.status + '"></span><div>' + esc(r.spec.title) + '<small>' + esc(r.spec.useCase) + ' · ' + new Date(r.created).toLocaleString() + '</small></div></div>').join('') : '<div class="muted" style="padding:6px">No runs yet. Every piece of work starts with a spec.</div>';
  $('#legend').innerHTML = '<div class="aside-title">Who takes part</div>' + Object.keys(ACTORS).map((a) => '<div>' + av(a) + esc(ACTORS[a].name) + '</div>').join('');
}

// ---------- the form ----------
function drawForm() {
  const f = form;
  const sugs = f.suggestions.map((s, i) => '<label class="sug"><input type="checkbox" data-sug="' + i + '"' + (f.context.includes(s.path) ? ' checked' : '') + '><div>' + esc(s.path) + '<div class="kind">' + esc(s.kind) + ' · ' + esc(s.reason) + '</div></div><a data-open="' + esc(s.path) + '" class="muted" style="cursor:pointer">open</a></label>').join('');
  const extra = f.context.filter((c) => !f.suggestions.some((s) => s.path === c)).map((c) => '<label class="sug"><input type="checkbox" checked data-ctx="' + esc(c) + '"><div>' + esc(c) + '<div class="kind">added by you</div></div><span></span></label>').join('');
  $('#main').innerHTML = '<div class="form">'
    + '<h1>New spec</h1><div class="muted">Every piece of work starts here: say what you want, give the agents the right context, choose who leads. The spec is written to <code>specs/&lt;id&gt;/spec.md</code> and drives the whole pipeline.' + (S.card ? ' Project: <b>' + esc(S.card.name) + '</b> (' + esc(S.card.platform ?? '') + ' · ' + esc(S.card.dialect) + ').' : '') + '</div>'
    + section(1, 'What do you want to do?', '<div class="cards">' + USE_CASES.map(([id, ico, name, hint]) => '<div class="card' + (f.useCase === id ? ' sel' : '') + '" data-uc="' + id + '" tabindex="0"><span class="ico">' + ico + '</span><b>' + name + '</b><span>' + hint + '</span></div>').join('') + '</div>')
    + section(2, 'The spec', '<div class="tabs">' + [['write', 'Write it'], ['jira', 'From Jira'], ['github', 'From a GitHub issue']].map(([id, n]) => '<button data-src="' + id + '" class="' + (f.srcTab === id ? 'sel' : '') + '">' + n + '</button>').join('') + '</div>'
      + (f.srcTab === 'jira' ? '<div class="row"><input id="jiraKey" placeholder="PROJ-123"><button id="jiraGo" class="primary">Import</button><button id="jiraMine">My open issues</button><button id="jiraSetup" title="Site, email and API token">Connect…</button></div>' + (f.mine.length ? '<div class="box" style="margin-bottom:10px">' + f.mine.map((i) => '<div class="sug" style="grid-template-columns:90px 1fr"><a data-jira="' + esc(i.key) + '" style="cursor:pointer">' + esc(i.key) + '</a><span>' + esc(i.title) + '</span></div>').join('') + '</div>' : '') : '')
      + (f.srcTab === 'github' ? '<div class="row"><input id="ghRef" placeholder="123 or owner/repo#123"><button id="ghGo" class="primary">Import</button></div>' : '')
      + (f.source.key ? '<div class="muted" style="margin-bottom:6px">Imported from ' + esc(f.source.kind) + ' <a data-url="' + esc(f.source.url) + '">' + esc(f.source.key) + '</a></div>' : '')
      + '<label class="f">Title</label><input id="title" style="width:100%" value="' + esc(f.title) + '" placeholder="Loans of books">'
      + '<label class="f">Description: what, for whom, why. Write it as you would to a teammate.</label><textarea id="desc" rows="8">' + esc(f.description) + '</textarea>'
      + '<label class="f">Acceptance criteria: each one is checked at the end</label>' + f.criteria.map((c, i) => '<div class="crit"><input data-crit="' + i + '" value="' + esc(c) + '" placeholder="A reader cannot borrow a book that is out"><button data-delcrit="' + i + '" title="Remove">✕</button></div>').join('') + '<div class="row"><button id="addCrit">＋ Criterion</button><button id="readCrit" title="Take the list under &quot;Acceptance criteria&quot; in the description">Read them from the description</button></div>')
    + section(3, 'Context for the agents', '<div class="muted" style="margin-bottom:8px">Suggested from the project and your skills by the words of the spec. The agent instructions are always worth giving.</div><div class="row"><button id="suggest">↻ Suggest again</button><input id="addCtx" placeholder="Another file: docs/context/x.md"><button id="addCtxGo">Add</button></div><div>' + (sugs + extra || '<div class="muted">Write the description, then suggest.</div>') + '</div>')
    + section(4, 'Who leads', '<div class="lead">'
      + '<div class="card' + (f.lead === 'claude' ? ' sel' : '') + '" data-lead="claude" tabindex="0">' + av('claude') + ' ' + av('coder') + '<b>Claude leads, the local developer writes</b><ul><li>Claude plans the pieces with the Smart Graph (MCP)</li><li>The local coder writes each one; Claude fixes only what it cannot and teaches the graph</li><li>Costs Claude tokens; the fastest path to a big change</li></ul></div>'
      + '<div class="card' + (f.lead === 'local' ? ' sel' : '') + '" data-lead="local" tabindex="0">' + av('planner') + ' ' + av('coder') + '<b>Local agents only</b><ul><li>The local planner splits the spec</li><li>The local coder, tester and reviewer do the rest</li><li>Free and private; best for small, well named pieces</li></ul></div></div>'
      + '<div class="row" style="margin-top:12px"><button id="preview">Preview the plan with the local planner</button><span class="muted">optional: edit the pieces before starting</span></div>'
      + (f.pieces.length ? '<table class="pieces"><tr class="muted"><td>file</td><td>kind</td><td>task</td><td></td></tr>' + f.pieces.map((p, i) => '<tr><td><input data-pc="' + i + '" data-k="path" value="' + esc(p.path) + '"></td><td style="width:110px"><input data-pc="' + i + '" data-k="kind" value="' + esc(p.kind) + '"></td><td><input data-pc="' + i + '" data-k="task" value="' + esc(p.task) + '"></td><td><button data-delpc="' + i + '">✕</button></td></tr>').join('') + '</table>' : ''))
    + '<div class="go"><button id="reset">Clear</button><button id="start" class="primary">▶ Start the loop</button></div></div>';
}
function section(n, title, body) { return '<div class="section"><div class="num">' + n + '</div><div><h2>' + title + '</h2>' + body + '</div></div>'; }
function readForm() {
  const t = $('#title'); if (t) form.title = t.value;
  const d = $('#desc'); if (d) form.description = d.value;
  document.querySelectorAll('[data-crit]').forEach((e) => (form.criteria[+e.dataset.crit] = e.value));
  document.querySelectorAll('[data-pc]').forEach((e) => (form.pieces[+e.dataset.pc][e.dataset.k] = e.value));
}
function specOf() {
  readForm();
  return { id: '', title: form.title.trim(), useCase: form.useCase, description: form.description, criteria: form.criteria.map((c) => c.trim()).filter(Boolean), context: form.context, source: form.source, lead: form.lead, pieces: form.pieces.filter((p) => p.path && p.task) };
}

// ---------- the run: a graph of what was done ----------
// A column per stage, a node per step under it in the order it ran, and under each step the steps its agent followed
// (recall, write, repair...). A click on any node opens it on the right: what it did, the decisions it took and why,
// its input, its output and its code. Any step can be run again, and the whole run from scratch.
const COLW = 222, GAPX = 40, HEAD = 56, NODE = 50, SUB = 24, GAPY = 12, RAIL = 14;
function failedStep(r) { for (const st of r.stages) { if (st.status !== 'failed') continue; const bad = [...st.steps].reverse().find((x) => x.status === 'failed'); if (bad) return { st, x: bad }; } return null; }
/** Where the run is, or where it failed: what is open when the user chose nothing. */
function pick(r) {
  for (const st of r.stages) for (const x of st.steps) if (x.status === 'running') return { stage: st.id, step: x.id };
  const f = failedStep(r);
  return f ? { stage: f.st.id, step: f.x.id } : { stage: null, step: null };
}
function drawRun() {
  const r = view.run;
  if (!r) { $('#main').innerHTML = '<div class="empty">Choose a run, or start a new spec.</div>'; return; }
  if (view.auto) Object.assign(view, pick(r));
  const g = $('#graph'), d = $('#drawer');
  const keep = g && $('#main').dataset.run === r.id ? [g.scrollLeft, g.scrollTop, d.scrollTop] : null;
  $('#main').innerHTML = head(r) + '<div class="split"><div class="graph" id="graph">' + graph(r) + '</div><div class="drawer" id="drawer">' + drawer(r) + '</div></div>';
  $('#main').dataset.run = r.id;
  if (keep) { $('#graph').scrollLeft = keep[0]; $('#graph').scrollTop = keep[1]; $('#drawer').scrollTop = keep[2]; }
  else $('.gnode.sel')?.scrollIntoView({ block: 'center', inline: 'center' });
}
function head(r) {
  const bad = failedStep(r);
  const idle = r.status !== 'running';
  const acc = r.acceptance ?? [];
  const met = acc.filter((a) => a.met).length;
  return '<div class="top"><div class="head"><h1>' + esc(r.spec.title) + '</h1><span class="pill"><span class="dot st-' + r.status + '"></span> ' + r.status + '</span><span class="muted">' + esc(r.spec.useCase) + ' · ' + (r.spec.lead === 'claude' ? 'Claude leads' : 'local only') + (r.analysis ? ' · strategy ' + esc(r.analysis.strategy.replace(/^strategy:/, '')) : '') + ' · ' + dur({ started: r.created, ended: r.ended }) + (r.costUsd ? ' · Claude USD ' + r.costUsd.toFixed(3) : '') + '</span><div class="grow"></div>'
    + (idle ? '' : '<button id="stop">■ Stop</button>')
    + (idle && bad ? '<button id="retry" class="primary" title="Go on from the step that failed; every step that passed is kept">↻ Retry ' + esc(bad.x.title.length > 44 ? bad.x.title.slice(0, 44) + '…' : bad.x.title) + '</button>' : '')
    + (idle ? '<button id="scratch" title="The whole pipeline again from the specification: every file this run wrote goes back to what it was, then every stage runs">⟲ Run again from scratch</button>' : '')
    + '<button data-open="specs/' + esc(r.id) + '/spec.md">Open spec</button></div>'
    + (r.diagnosis && idle && bad ? '<div class="accept bad" data-stage="' + bad.st.id + '" data-step="' + esc(bad.x.id) + '" tabindex="0"><b>Why it failed:</b> ' + esc(r.diagnosis.split('\n').filter(Boolean).slice(0, 2).join(' · ')) + ' <span class="muted">(open the step for the whole diagnosis)</span></div>' : '')
    + (acc.length ? '<div class="accept ' + (met === acc.length ? 'ok' : 'warn') + '" data-over="1" tabindex="0">Acceptance criteria: ' + met + ' of ' + acc.length + ' shown met' + (met === acc.length ? '' : ' — ' + esc(acc.filter((a) => !a.met).map((a) => a.criterion).join('; '))) + '</div>' : '')
    + ((r.interrupted ?? []).slice(-1).map((i) => '<div class="muted">⚠ Interrupted at ' + esc(i.stage + (i.step ? ' · ' + i.step : '')) + ' (' + new Date(i.at).toLocaleString() + '): the process that ran it stopped; undone: ' + esc(i.undone.join(', ') || 'nothing') + '.</div>').join(''))
    + '<div class="muted hint">Click a node to see what it did, the decisions it took and why. Any step can be run again.' + ((r.previous ?? []).length ? ' <a data-over="1">' + r.previous.length + ' earlier attempt' + (r.previous.length === 1 ? '' : 's') + '</a>' : '') + '</div></div>';
}
function graph(r) {
  let nodes = '', edges = '', bottom = 0;
  const path = (d, cls) => '<path class="' + cls + '" d="' + d + '"/>';
  r.stages.forEach((st, i) => {
    const x = i * (COLW + GAPX);
    const on = view.stage === st.id && !view.step;
    nodes += '<div class="gnode gstage ' + st.status + (on ? ' sel' : '') + '" style="left:' + x + 'px;top:0;width:' + COLW + 'px;height:' + HEAD + 'px" data-stage="' + st.id + '" tabindex="0"><div class="n">' + (i + 1) + ' · ' + (st.status === 'pending' ? 'waiting' : st.status) + (st.started ? ' · ' + dur(st) : '') + '</div><div class="t"><span class="dot st-' + st.status + '"></span>' + esc(st.title) + '</div></div>';
    if (i) edges += path('M' + (x - GAPX) + ' ' + HEAD / 2 + ' L' + (x - 5) + ' ' + HEAD / 2, 'e arrow' + (st.status === 'running' ? ' flow' : ''));
    let y = HEAD + GAPY * 2, from = HEAD;
    for (const s of st.steps) {
      const picked = view.stage === st.id && view.step === s.id;
      edges += path('M' + (x + RAIL) + ' ' + from + ' L' + (x + RAIL) + ' ' + (y - 4), 'e arrow');
      nodes += '<div class="gnode gstep ' + s.status + (picked ? ' sel' : '') + '" style="left:' + x + 'px;top:' + y + 'px;width:' + COLW + 'px;height:' + NODE + 'px" data-stage="' + st.id + '" data-step="' + esc(s.id) + '" tabindex="0" title="' + esc(s.title) + '">' + av(s.actor) + '<div class="gt"><b>' + esc(s.title) + '</b><small>' + esc(s.summary || (s.status === 'running' ? 'working…' : '')) + '</small></div><div class="gm">' + (s.decisions?.length ? '<span class="dec" title="' + s.decisions.length + ' decision' + (s.decisions.length === 1 ? '' : 's') + '">◆' + s.decisions.length + '</span>' : '') + '<span>' + dur(s) + '</span></div></div>';
      y += NODE;
      from = y;
      (s.trace ?? []).forEach((t, k) => {
        const mid = y + 4 + SUB / 2;
        edges += path('M' + (x + RAIL) + ' ' + (y - 2) + ' L' + (x + RAIL) + ' ' + mid + ' L' + (x + RAIL + 14) + ' ' + mid, 'e');
        nodes += '<div class="gnode gsub' + (picked && view.trace === k ? ' sel' : '') + '" style="left:' + (x + RAIL + 16) + 'px;top:' + (y + 4) + 'px;width:' + (COLW - RAIL - 16) + 'px;height:' + SUB + 'px" data-stage="' + st.id + '" data-step="' + esc(s.id) + '" data-trace="' + k + '" tabindex="0" title="' + esc(t.detail) + '"><b>' + esc(t.step) + '</b> ' + esc(t.detail) + '</div>';
        y += SUB + 4;
        from = y;
      });
      y += GAPY;
    }
    bottom = Math.max(bottom, y);
  });
  const w = r.stages.length * (COLW + GAPX) - GAPX, h = bottom + 24;
  return '<div class="canvas" style="width:' + w + 'px;height:' + h + 'px"><svg width="' + w + '" height="' + h + '"><defs><marker id="ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0 L8 4 L0 8 z"/></marker></defs>' + edges + '</svg>' + nodes + '</div>';
}
function drawer(r) {
  const st = r.stages.find((s) => s.id === view.stage);
  const x = st?.steps.find((s) => s.id === view.step);
  return x ? stepInfo(r, st, x) : st ? stageInfo(r, st) : runInfo(r);
}
const whoOf = (actors) => '<div class="who">' + actors.map((a) => '<div>' + av(a) + '<div><b>' + esc(ACTORS[a].name) + '</b><small>' + esc(ACTORS[a].does) + '</small><small>✕ ' + esc(ACTORS[a].not) + '</small></div></div>').join('') + '</div>';
function runInfo(r) {
  const acc = r.acceptance ?? [];
  const crit = r.spec.criteria.map((c, i) => { const a = acc[i]; return '<div class="crow">' + (a ? (a.met ? '<span class="okc">☑</span>' : '<span class="badc">☐</span>') : '☐') + '<div>' + esc(c) + (a ? '<small>' + esc(a.evidence) + '</small>' : '') + '</div></div>'; }).join('');
  const active = r.stages.find((s) => s.status === 'running');
  const tries = (r.previous ?? []).map((p, i) => '<div class="crow"><span class="dot st-' + p.status + '"></span><div>Attempt ' + (i + 1) + ' ended ' + esc(p.status) + '; then run again from ' + esc(p.from) + (p.why ? ': ' + esc(p.why) : '') + '<small>' + new Date(p.at).toLocaleString() + (p.undone?.length ? ' · undone: ' + esc(p.undone.join(', ')) : '') + '</small></div></div>').join('');
  return '<h2>' + (active ? 'Now: ' + esc(active.title) : 'The run') + '</h2><div class="muted">' + esc((active ?? r.stages[0]).about) + '</div>'
    + (r.analysis ? '<h3>Strategy</h3><div>' + esc(r.analysis.title.replace(/^Strategy: /, '')) + '<small class="muted block">' + esc(r.analysis.why) + '</small></div>' : '')
    + '<h3>Acceptance criteria' + (acc.length ? '' : ' <span class="muted">(checked when the verification passes)</span>') + '</h3>' + crit
    + (r.notes && r.status !== 'running' ? '<h3>What the local developer says</h3><pre>' + esc(r.notes) + '</pre>' : '')
    + (tries ? '<h3>Earlier attempts</h3>' + tries + '<small class="muted block">Their steps are kept whole in .nuclear/loop/runs/' + esc(r.id) + '.json</small>' : '')
    + '<h3>Who does what in this run</h3>' + whoOf([...new Set(r.stages.flatMap((s) => s.steps.length ? s.steps.map((x) => x.actor) : s.actors))]);
}
function stageInfo(r, s) {
  return '<div class="dhead"><h2>' + esc(s.title) + '</h2><span class="pill"><span class="dot st-' + s.status + '"></span> ' + s.status + '</span><span class="muted">' + dur(s) + '</span></div>'
    + '<div class="muted">' + esc(s.about) + '</div>'
    + (r.status !== 'running' && s.status !== 'pending' ? '<div class="acts"><button id="retryStage" class="primary" title="This whole stage and every stage after it run again; what they wrote is undone first">⟲ Run ' + esc(s.title) + ' again</button></div>' : '')
    + '<h3>' + s.steps.length + ' step' + (s.steps.length === 1 ? '' : 's') + '</h3>' + s.steps.map((x) => '<div class="crow link" data-stage="' + s.id + '" data-step="' + esc(x.id) + '"><span class="dot st-' + x.status + '"></span><div>' + esc(x.title) + '<small>' + esc(x.summary) + '</small></div></div>').join('')
    + '<h3>Who takes part</h3>' + whoOf(s.actors);
}
function stepInfo(r, s, x) {
  const tabs = [['trace', 'What it did'], ['code', 'Code'], ['log', x.actor === 'shell' ? 'Output' : x.actor === 'security' ? 'Findings' : 'Log'], ['agent', 'For the agent'], ['input', 'Input']].filter(([id]) => id === 'trace' || (id === 'code' ? x.code : id === 'log' ? x.log : id === 'agent' ? x.agent : x.input));
  if (!tabs.some(([id]) => id === view.tab)) view.tab = 'trace';
  const followed = (x.trace ?? []).map((t, k) => '<div class="flow-n' + (view.trace === k ? ' sel' : '') + '"><span class="num2">' + (k + 1) + '</span><div><b>' + esc(t.step) + '</b><div>' + esc(t.detail) + '</div></div></div>').join('<div class="flow-a">↓</div>');
  const decided = (x.decisions ?? []).map((d) => '<div class="decn"><span>◆</span><div><b>' + esc(d.what) + '</b><div class="muted">because ' + esc(d.why) + '</div></div></div>').join('');
  const files = (x.files ?? []).map((f) => '<div><a data-open="' + esc(f) + '">' + esc(f) + '</a></div>').join('');
  const did = '<h3>Who</h3>' + whoOf([x.actor])
    + '<h3>The steps it followed</h3>' + (followed || '<div class="muted">' + (x.actor === 'shell' ? 'One command: its output is in Output.' : x.status === 'running' ? 'Working…' : 'It did one thing: ' + esc(x.summary)) + '</div>')
    + '<h3>The decisions it took, and why</h3>' + (decided || '<div class="muted">No choice was made here: the step had one way to go.</div>')
    + (files ? '<h3>Files it wrote</h3>' + files : '');
  const panes = { trace: did, code: '<pre>' + esc(x.code) + '</pre>', log: '<pre>' + esc(x.log) + '</pre>', agent: '<div class="muted">The failure as the local agent read it (in Nuclear, by dragonfly explain); the raw output is in Output.</div><pre>' + esc(x.agent) + '</pre>', input: '<pre>' + esc(x.input) + '</pre>' };
  return '<div class="dhead">' + av(x.actor) + '<h2>' + esc(x.title) + '</h2><span class="pill"><span class="dot st-' + x.status + '"></span> ' + x.status + '</span></div>'
    + '<div class="muted">' + esc(s.title) + ' · ' + esc(x.id) + (dur(x) ? ' · ' + dur(x) : '') + (x.tool ? ' · tool ' + esc(x.tool) : '') + '</div>'
    + '<div class="sum">' + esc(x.summary) + '</div>'
    + '<div class="acts">' + (r.status !== 'running' ? '<button id="retryStep" class="primary" title="This step and every step after it run again, whether it passed or failed; the steps before it are kept and what the others wrote is undone first">↻ Run again from this step</button>' : '') + (x.file ? '<button data-open="' + esc(x.file) + '">Open ' + esc(x.file.split('/').pop()) + '</button>' : '') + '</div>'
    + (x.status === 'failed' && r.diagnosis && failedStep(r)?.x.id === x.id ? '<div class="diagnosis"><b>Why it failed</b> <span class="muted">(local diagnoser)</span><pre>' + esc(r.diagnosis) + '</pre></div>' : '')
    + '<div class="dtabs">' + tabs.map(([id, n]) => '<button data-tab="' + id + '" class="' + (view.tab === id ? 'sel' : '') + '">' + n + '</button>').join('') + '</div>' + panes[view.tab];
}

function draw() { drawChrome(); $('#main').className = view.mode === 'run' && view.run ? 'run' : ''; if (view.mode === 'form') drawForm(); else drawRun(); }

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-uc],[data-src],[data-lead],[data-stage],[data-over],[data-run],[data-tab],[data-open],[data-ci],[data-jira],[data-delcrit],[data-delpc],[data-sug],[data-ctx],button,a');
  if (!t) { $('#ciPop').classList.remove('open'); if (e.target.closest('.canvas')) { Object.assign(view, { stage: null, step: null, trace: null, auto: false }); drawRun(); } return; }
  const d = t.dataset;
  if (t.id !== 'ci') $('#ciPop').classList.remove('open');
  if (d.uc) { readForm(); if (!form.description.trim() || Object.values(TEMPLATES).includes(form.description)) form.description = TEMPLATES[d.uc]; form.useCase = d.uc; return drawForm(); }
  if (d.src) { readForm(); form.srcTab = d.src; return drawForm(); }
  if (d.lead) { readForm(); form.lead = d.lead; return drawForm(); }
  if (d.delcrit) { readForm(); form.criteria.splice(+d.delcrit, 1); return drawForm(); }
  if (d.delpc) { readForm(); form.pieces.splice(+d.delpc, 1); return drawForm(); }
  if (d.sug !== undefined && t.tagName === 'INPUT') { const p = form.suggestions[+d.sug].path; form.context = t.checked ? [...form.context, p] : form.context.filter((c) => c !== p); return; }
  if (d.ctx !== undefined && t.tagName === 'INPUT') { form.context = form.context.filter((c) => c !== d.ctx); readForm(); return drawForm(); }
  if (d.stage) { Object.assign(view, { stage: d.stage, step: d.step ?? null, trace: d.trace === undefined ? null : +d.trace, auto: false }); if (d.trace !== undefined) view.tab = 'trace'; return drawRun(); }
  if (d.over) { Object.assign(view, { stage: null, step: null, trace: null, auto: false }); return drawRun(); }
  if (d.run) { view = { mode: 'run', run: S.runs.find((r) => r.id === d.run), stage: null, step: null, trace: null, tab: 'trace', auto: true }; return draw(); }
  if (d.tab) { view.tab = d.tab; return drawRun(); }
  if (d.open) return vscode.postMessage({ type: 'open', file: d.open });
  if (d.ci) return vscode.postMessage({ type: 'exportCi', provider: d.ci });
  if (d.jira) { $('#jiraKey') && ($('#jiraKey').value = d.jira); return vscode.postMessage({ type: 'jira', key: d.jira }); }
  switch (t.id) {
    case 'new': view = { mode: 'form', run: null, stage: null, step: null, trace: null, tab: 'trace', auto: true }; return draw();
    case 'ci': return $('#ciPop').classList.toggle('open');
    case 'config': return vscode.postMessage({ type: 'config' });
    case 'addCrit': readForm(); form.criteria.push(''); drawForm(); return document.querySelector('[data-crit="' + (form.criteria.length - 1) + '"]')?.focus();
    case 'readCrit': { readForm(); const lines = form.description.split('\n'); const at = lines.findIndex((l) => /acceptance criteria|criterios de aceptaci/i.test(l)); const found = at < 0 ? [] : lines.slice(at + 1).map((l) => l.match(/^\s*(?:[-*]|\d+[.)])\s+(.+)$/)?.[1]).filter(Boolean); if (!found.length) return toast('No list under "Acceptance criteria" in the description.'); form.criteria = found; return drawForm(); }
    case 'suggest': readForm(); return vscode.postMessage({ type: 'suggest', text: form.title + ' ' + form.description });
    case 'addCtxGo': { const v = $('#addCtx').value.trim(); if (v) { readForm(); form.context.push(v); drawForm(); } return; }
    case 'jiraGo': return vscode.postMessage({ type: 'jira', key: $('#jiraKey').value });
    case 'jiraMine': return vscode.postMessage({ type: 'jiraMine' });
    case 'jiraSetup': return vscode.postMessage({ type: 'jiraSetup' });
    case 'ghGo': return vscode.postMessage({ type: 'github', ref: $('#ghRef').value });
    case 'preview': { const s = specOf(); if (!s.title) return toast('Give the spec a title first.', true); toast('The local planner is splitting the spec…'); return vscode.postMessage({ type: 'plan', spec: s }); }
    case 'reset': form = blank(); return drawForm();
    case 'start': { const s = specOf(); if (!s.title) return toast('The spec needs a title.', true); if (!s.criteria.length) return toast('Add at least one acceptance criterion: it is how the run knows it is done.', true); return vscode.postMessage({ type: 'start', spec: s }); }
    case 'stop': return vscode.postMessage({ type: 'stop', id: view.run.id });
    case 'retry': view.auto = true; return vscode.postMessage({ type: 'retry', id: view.run.id, step: true });
    case 'retryStep': { const step = view.step; view.auto = true; return vscode.postMessage({ type: 'retry', id: view.run.id, step }); }
    case 'retryStage': { const stage = view.stage; view.auto = true; return vscode.postMessage({ type: 'retry', id: view.run.id, stage, step: false }); }
    case 'scratch': view.auto = true; return vscode.postMessage({ type: 'retry', id: view.run.id, scratch: true });
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card,.gnode,.accept,.run-item')) { e.preventDefault(); e.target.click(); }
  if (e.key === 'Escape' && view.mode === 'run') { if (view.step) Object.assign(view, { step: null, trace: null, auto: false }); else Object.assign(view, { stage: null, auto: false }); drawRun(); }
});
$('#project').addEventListener('change', (e) => vscode.postMessage({ type: 'project', root: e.target.value }));
let suggestTimer;
document.addEventListener('input', (e) => { if (e.target.id === 'desc' || e.target.id === 'title') { clearTimeout(suggestTimer); suggestTimer = setTimeout(() => { readForm(); vscode.postMessage({ type: 'suggest', text: form.title + ' ' + form.description }); }, 900); } });

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') { S = m; if (view.run) view.run = S.runs.find((r) => r.id === view.run.id) ?? view.run; if (view.mode === 'form' && !form.suggestions.length) vscode.postMessage({ type: 'suggest', text: form.title + ' ' + form.description }); draw(); }
  if (m.type === 'run') { const i = S.runs.findIndex((r) => r.id === m.run.id); if (i >= 0) S.runs[i] = m.run; else S.runs.unshift(m.run); if (m.select) view = { mode: 'run', run: m.run, stage: null, step: null, trace: null, tab: 'trace', auto: true }; if (view.run?.id === m.run.id) view.run = m.run; draw(); }
  if (m.type === 'suggestions') { form.suggestions = m.list; if (!form.context.length) form.context = m.list.filter((s) => s.kind === 'agents').map((s) => s.path); if (view.mode === 'form') { readForm(); drawForm(); } }
  if (m.type === 'issue') { readForm(); const i = m.issue; form.title = i.title; form.description = i.description; form.criteria = i.criteria.length ? i.criteria : ['']; form.source = { kind: m.source, key: i.key, url: i.url }; form.srcTab = 'write'; drawForm(); toast('Imported ' + i.key + (i.criteria.length ? ' with ' + i.criteria.length + ' criteria' : ': add its acceptance criteria')); vscode.postMessage({ type: 'suggest', text: i.title + ' ' + i.description }); }
  if (m.type === 'mine') { form.mine = m.issues; drawForm(); }
  if (m.type === 'pieces') { readForm(); form.pieces = m.pieces; drawForm(); toast(m.pieces.length + ' pieces: edit them or start.'); }
  if (m.type === 'error') toast(m.text, true);
  if (m.type === 'info') toast(m.text);
});
setInterval(() => { if (view.mode === 'run' && view.run?.status === 'running') drawRun(); }, 1000);
vscode.postMessage({ type: 'ready' });
`;
