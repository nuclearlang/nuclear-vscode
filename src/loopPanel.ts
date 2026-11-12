// The Loop tool (ADR-0102): one full-screen page, like Devices and HTTP. On the left the runs of the active project;
// in the middle either the spec form (the start of every piece of work: the use case, the spec written here or
// imported from Jira or GitHub, the context the agents get, who leads) or a run drawn as a pipeline. The pipeline
// reads like a C4 diagram: level 1 is the whole process, a click on a stage zooms into its steps (level 2), a click on
// a step zooms into what its actor did (level 3: the trace, the code, the output). The engine (loopEngine.ts) does
// the work; this file only draws it and passes the user's choices. Plain HTML and script, no framework.
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { jiraAuth, machineConfig } from './aiSettings';
import { notices } from './notifications';
import { readCard } from './card';
import { CiProvider, ciFile, githubIssue, jiraIssue, JiraAuth, jiraMine, listRuns, LoopEngine, newRun, Piece, readConfig, recoverRuns, Run, slug, Spec, suggestContext, writeConfig, CONFIG_FILE } from './loopEngine';

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
  | { type: 'retry'; id: string; step: boolean }
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
        return this.drive(run, (e) => e.start(undefined, m.step));
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
  <div class="brand"><svg viewBox="0 0 16 16"><path d="M8 1.5a6.5 6.5 0 1 0 6.3 8"/><path d="M14.5 4.5v4h-4"/></svg><b>Loop</b><span class="muted">spec → plan → code → test → security → artifacts → deploy</span></div>
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
button:focus-visible, a:focus-visible, .node:focus-visible, .card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
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
main { flex: 1; overflow: auto; position: relative; }
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
/* the run */
.crumbs { padding: 12px 22px 0; display: flex; gap: 6px; align-items: center; color: var(--muted); }
.crumbs a { cursor: pointer; color: var(--vscode-textLink-foreground); }
.view { padding: 18px 22px 60px; transform-origin: var(--ox, 50%) var(--oy, 30%); }
.view.zoom { animation: zoom .32s ease-out; }
.view.back { animation: back .28s ease-out; }
@keyframes zoom { from { transform: scale(.25); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes back { from { transform: scale(1.6); opacity: 0; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .view.zoom, .view.back, .st-running { animation: none; } }
.head { display: flex; gap: 14px; align-items: baseline; flex-wrap: wrap; }
.head h1 { font-size: 19px; margin: 0; }
.diagnosis { margin: 8px 0 12px; padding: 8px 12px; border-left: 3px solid #d97706; background: var(--vscode-textCodeBlock-background); }
.diagnosis pre { white-space: pre-wrap; margin: 6px 0 0; font-family: var(--vscode-editor-font-family); }
.pill { padding: 2px 9px; border-radius: 10px; font-size: 11.5px; border: 1px solid var(--line); }
.pipeline { display: flex; align-items: stretch; margin: 26px 0 18px; overflow-x: auto; padding-bottom: 6px; }
.node { min-width: 118px; flex: 1 1 0; border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: var(--card); cursor: pointer; position: relative; }
.node:hover { border-color: var(--accent); transform: translateY(-1px); }
.node.running { border-color: var(--run); box-shadow: 0 0 0 3px color-mix(in srgb, var(--run) 25%, transparent); }
.node.failed { border-color: var(--bad); } .node.passed { border-color: color-mix(in srgb, var(--ok) 60%, var(--line)); }
.node .t { display: flex; gap: 7px; align-items: center; font-weight: 600; }
.node .n { font-size: 11px; color: var(--muted); }
.node .meta { color: var(--muted); font-size: 11.5px; margin-top: 6px; min-height: 16px; }
.node .actors { display: flex; gap: 3px; margin-top: 8px; }
.link { width: 16px; flex-shrink: 0; align-self: center; height: 2px; background: var(--line); position: relative; }
.link.flow { background: linear-gradient(90deg, var(--run) 50%, var(--line) 50%); background-size: 12px 2px; animation: flow .6s linear infinite; }
@keyframes flow { to { background-position: 12px 0; } }
.grid2 { display: grid; grid-template-columns: 1.4fr 1fr; gap: 16px; }
.box { border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; background: var(--card); }
.box h3 { margin: 0 0 8px; font-size: 13px; }
.who { display: grid; gap: 10px; } .who > div { display: grid; grid-template-columns: 22px 1fr; gap: 8px; align-items: start; }
.who small { color: var(--muted); display: block; }
.steps { position: relative; margin-left: 10px; border-left: 2px solid var(--line); padding-left: 18px; }
.stepn { position: relative; border: 1px solid var(--line); border-radius: 8px; padding: 9px 12px; margin-bottom: 10px; cursor: pointer; background: var(--card); display: grid; grid-template-columns: 22px 1fr auto; gap: 10px; align-items: center; }
.stepn:hover { border-color: var(--accent); }
.stepn::before { content: ''; position: absolute; left: -26px; top: 15px; width: 12px; height: 12px; border-radius: 50%; background: var(--bg); border: 2px solid var(--line); }
.stepn.passed::before { border-color: var(--ok); background: var(--ok); } .stepn.failed::before { border-color: var(--bad); background: var(--bad); } .stepn.running::before { border-color: var(--run); background: var(--run); }
.stepn small { color: var(--muted); display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 60vw; }
pre { background: var(--vscode-textCodeBlock-background, #0002); padding: 10px; border-radius: 6px; overflow: auto; max-height: 52vh; white-space: pre-wrap; font: 12px/1.45 var(--vscode-editor-font-family); margin: 0; }
.trace { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0 14px; }
.trace .tn { border: 1px solid var(--line); border-radius: 6px; padding: 6px 9px; background: var(--card); max-width: 300px; }
.trace .tn b { display: block; font-size: 11px; text-transform: uppercase; color: var(--muted); }
.trace .arrow { color: var(--muted); }
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
let view = { mode: 'form', run: null, stage: null, step: null, tab: 'trace' };
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

// ---------- the run ----------
function drawRun() {
  const r = view.run;
  if (!r) { $('#main').innerHTML = '<div class="empty">Choose a run, or start a new spec.</div>'; return; }
  const stage = r.stages.find((s) => s.id === view.stage);
  const step = stage?.steps.find((s) => s.id === view.step);
  const crumbs = '<div class="crumbs"><a data-go="1">Pipeline</a>' + (stage ? ' › <a data-go="2">' + esc(stage.title) + '</a>' : '') + (step ? ' › <span>' + esc(step.title) + '</span>' : '') + '</div>';
  let body = '';
  if (!stage) body = level1(r);
  else if (!step) body = level2(r, stage);
  else body = level3(r, stage, step);
  const prevLevel = $('#main').dataset.level;
  const level = step ? 3 : stage ? 2 : 1;
  $('#main').innerHTML = crumbs + '<div class="view" id="v">' + body + '</div>';
  $('#main').dataset.level = level;
  if (prevLevel && +prevLevel !== level) $('#v').classList.add(+prevLevel < level ? 'zoom' : 'back');
  $('#v').style.setProperty('--ox', view.ox ?? '50%'); $('#v').style.setProperty('--oy', view.oy ?? '30%');
}
function level1(r) {
  const nodes = r.stages.map((s, i) => {
    const acts = [...new Set(s.steps.map((x) => x.actor))]; const show = acts.length ? acts : s.actors;
    const last = s.steps[s.steps.length - 1];
    return (i ? '<div class="link' + (s.status === 'running' ? ' flow' : '') + '"></div>' : '') + '<div class="node ' + s.status + '" data-stage="' + s.id + '" tabindex="0"><div class="n">' + (i + 1) + '</div><div class="t"><span class="dot st-' + s.status + '"></span>' + esc(s.title) + '</div><div class="meta">' + (s.status === 'pending' ? 'waiting' : s.status === 'skipped' ? 'skipped' : s.steps.length + ' step' + (s.steps.length === 1 ? '' : 's') + ' · ' + dur(s)) + '</div><div class="meta">' + esc(last?.summary ?? '') + '</div><div class="actors">' + show.map(av).join('') + '</div></div>';
  }).join('');
  const crit = r.spec.criteria.map((c) => '<div>☐ ' + esc(c) + '</div>').join('');
  const active = r.stages.find((s) => s.status === 'running');
  return '<div class="head"><h1>' + esc(r.spec.title) + '</h1><span class="pill"><span class="dot st-' + r.status + '"></span> ' + r.status + '</span><span class="muted">' + esc(r.spec.useCase) + ' · ' + (r.spec.lead === 'claude' ? 'Claude leads' : 'local only') + ' · ' + dur({ started: r.created, ended: r.ended }) + (r.costUsd ? ' · Claude USD ' + r.costUsd.toFixed(3) : '') + '</span><div class="grow"></div>' + (r.status === 'running' ? '<button id="stop">■ Stop</button>' : '') + (r.status === 'failed' || r.status === 'skipped' ? (() => { const st = r.stages.find((s) => s.status === 'failed') ?? r.stages.find((s) => s.status === 'skipped'); const bad = st ? [...st.steps].reverse().find((x) => x.status === 'failed') : undefined; return '<button id="retry" class="primary" title="Go on from the step that failed; every step that passed is kept">↻ Retry ' + esc(bad ? bad.title : (st ?? {}).title ?? 'the run') + '</button><button id="retryStage" title="Run the whole stage again; the stages before it are kept">Restart ' + esc((st ?? {}).title ?? 'stage') + '</button>'; })() : '') + '<button data-open="specs/' + esc(r.id) + '/spec.md">Open spec</button></div>'
    + (r.diagnosis && r.status !== 'running' ? '<div class="diagnosis"><b>Why it failed</b> <span class="muted">(local diagnoser)</span><pre>' + esc(r.diagnosis) + '</pre></div>' : '')
    + ((r.previous ?? []).length ? '<div class="muted">Retried ' + r.previous.length + ' time' + (r.previous.length === 1 ? '' : 's') + '; the earlier attempts are kept in the run file.</div>' : '')
    + ((r.interrupted ?? []).map((i) => '<div class="muted">⚠ Interrupted at ' + esc(i.stage + (i.step ? ' · ' + i.step : '')) + ' (' + new Date(i.at).toLocaleString() + '): the process that ran it stopped; undone: ' + esc(i.undone.join(', ') || 'nothing') + '. The trace log is .nuclear/loop/runs/' + esc(r.id) + '.log.</div>').join(''))
    + '<div class="pipeline">' + nodes + '</div>'
    + '<div class="grid2"><div class="box"><h3>' + (active ? 'Now: ' + esc(active.title) : 'The process') + '</h3><div class="muted">' + esc((active ?? r.stages[0]).about) + '</div><h3 style="margin-top:14px">Acceptance criteria</h3>' + crit + '</div>'
    + '<div class="box"><h3>Who does what in this run</h3><div class="who">' + [...new Set(r.stages.flatMap((s) => s.steps.length ? s.steps.map((x) => x.actor) : s.actors))].map((a) => '<div>' + av(a) + '<div><b>' + esc(ACTORS[a].name) + '</b><small>' + esc(ACTORS[a].does) + '</small><small>✕ ' + esc(ACTORS[a].not) + '</small></div></div>').join('') + '</div></div></div>'
    + '<div class="muted" style="margin-top:14px">Click a stage to zoom into its steps.</div>';
}
function level2(r, s) {
  const steps = s.steps.map((x) => '<div class="stepn ' + x.status + '" data-step="' + esc(x.id) + '" tabindex="0">' + av(x.actor) + '<div><b>' + esc(x.title) + '</b><small>' + esc(x.summary || (x.status === 'running' ? 'working…' : '')) + '</small></div><span class="muted">' + dur(x) + '</span></div>').join('');
  return '<div class="head"><h1>' + esc(s.title) + '</h1><span class="pill"><span class="dot st-' + s.status + '"></span> ' + s.status + '</span><span class="muted">' + dur(s) + '</span></div>'
    + '<div class="grid2" style="margin-top:14px"><div><div class="muted" style="margin-bottom:14px">' + esc(s.about) + '</div>' + (steps ? '<div class="steps">' + steps + '</div>' : '<div class="empty" style="padding:30px">' + (s.status === 'pending' ? 'It has not started.' : 'No steps.') + '</div>') + '</div>'
    + '<div class="box"><h3>Who takes part</h3><div class="who">' + s.actors.map((a) => '<div>' + av(a) + '<div><b>' + esc(ACTORS[a].name) + '</b><small>' + esc(ACTORS[a].does) + '</small><small>✕ ' + esc(ACTORS[a].not) + '</small></div></div>').join('') + '</div></div></div>';
}
function level3(r, s, x) {
  const trace = x.trace?.length ? '<div class="trace">' + x.trace.map((t, i) => (i ? '<span class="arrow">→</span>' : '') + '<div class="tn"><b>' + esc(t.step) + '</b>' + esc(t.detail) + '</div>').join('') + '</div>' : '';
  const tabs = [['trace', 'What it did'], ['code', 'Code'], ['log', x.actor === 'shell' ? 'Output' : x.actor === 'security' ? 'Findings' : 'Log'], ['agent', 'For the agent'], ['input', 'Input']].filter(([id]) => id === 'trace' || (id === 'code' ? x.code : id === 'log' ? x.log : id === 'agent' ? x.agent : x.input));
  if (!tabs.some(([id]) => id === view.tab)) view.tab = tabs[0][0];
  const panes = { trace: '<div class="who"><div>' + av(x.actor) + '<div><b>' + esc(ACTORS[x.actor].name) + '</b><small>' + esc(ACTORS[x.actor].does) + '</small></div></div></div>' + (trace || '<div class="muted" style="margin-top:10px">' + esc(x.summary) + '</div>'), code: '<pre>' + esc(x.code) + '</pre>', log: '<pre>' + esc(x.log) + '</pre>', agent: '<div class="muted">The failure as the local agent read it (in Nuclear, by dragonfly explain); the raw output is in Output.</div><pre>' + esc(x.agent) + '</pre>', input: '<pre>' + esc(x.input) + '</pre>' };
  return '<div class="head">' + av(x.actor) + '<h1>' + esc(x.title) + '</h1><span class="pill"><span class="dot st-' + x.status + '"></span> ' + x.status + '</span><span class="muted">' + dur(x) + (x.tool ? ' · tool ' + esc(x.tool) : '') + '</span><div class="grow"></div>' + (x.status === 'failed' && r.status !== 'running' ? '<button id="retry" class="primary" title="Go on from this step; every step that passed is kept">↻ Retry this step</button>' : '') + (x.file ? '<button data-open="' + esc(x.file) + '">Open ' + esc(x.file) + '</button>' : '') + '</div>'
    + '<div class="muted" style="margin-top:6px">' + esc(x.summary) + '</div>'
    + (x.status === 'failed' && r.diagnosis ? '<div class="diagnosis"><b>Why it failed</b> <span class="muted">(local diagnoser)</span><pre>' + esc(r.diagnosis) + '</pre></div>' : '')
    + '<div class="dtabs">' + tabs.map(([id, n]) => '<button data-tab="' + id + '" class="' + (view.tab === id ? 'sel' : '') + '">' + n + '</button>').join('') + '</div>' + panes[view.tab];
}

function draw() { drawChrome(); if (view.mode === 'form') drawForm(); else drawRun(); }
function origin(el) { const r = el.getBoundingClientRect(); const m = $('#main').getBoundingClientRect(); view.ox = (r.left + r.width / 2 - m.left) + 'px'; view.oy = (r.top + r.height / 2 - m.top + $('#main').scrollTop) + 'px'; }

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-uc],[data-src],[data-lead],[data-stage],[data-step],[data-go],[data-run],[data-tab],[data-open],[data-ci],[data-jira],[data-delcrit],[data-delpc],[data-sug],[data-ctx],button,a');
  if (!t) { $('#ciPop').classList.remove('open'); return; }
  const d = t.dataset;
  if (t.id !== 'ci') $('#ciPop').classList.remove('open');
  if (d.uc) { readForm(); if (!form.description.trim() || Object.values(TEMPLATES).includes(form.description)) form.description = TEMPLATES[d.uc]; form.useCase = d.uc; return drawForm(); }
  if (d.src) { readForm(); form.srcTab = d.src; return drawForm(); }
  if (d.lead) { readForm(); form.lead = d.lead; return drawForm(); }
  if (d.delcrit) { readForm(); form.criteria.splice(+d.delcrit, 1); return drawForm(); }
  if (d.delpc) { readForm(); form.pieces.splice(+d.delpc, 1); return drawForm(); }
  if (d.sug !== undefined && t.tagName === 'INPUT') { const p = form.suggestions[+d.sug].path; form.context = t.checked ? [...form.context, p] : form.context.filter((c) => c !== p); return; }
  if (d.ctx !== undefined && t.tagName === 'INPUT') { form.context = form.context.filter((c) => c !== d.ctx); readForm(); return drawForm(); }
  if (d.stage) { origin(t); view.stage = d.stage; view.step = null; return drawRun(); }
  if (d.step) { origin(t); view.step = d.step; view.tab = 'trace'; return drawRun(); }
  if (d.go) { if (d.go === '1') { view.stage = null; view.step = null; } else view.step = null; return drawRun(); }
  if (d.run) { view = { mode: 'run', run: S.runs.find((r) => r.id === d.run), stage: null, step: null, tab: 'trace' }; return draw(); }
  if (d.tab) { view.tab = d.tab; return drawRun(); }
  if (d.open) return vscode.postMessage({ type: 'open', file: d.open });
  if (d.ci) return vscode.postMessage({ type: 'exportCi', provider: d.ci });
  if (d.jira) { $('#jiraKey') && ($('#jiraKey').value = d.jira); return vscode.postMessage({ type: 'jira', key: d.jira }); }
  switch (t.id) {
    case 'new': view = { mode: 'form', run: null, stage: null, step: null, tab: 'trace' }; return draw();
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
    case 'retry': return vscode.postMessage({ type: 'retry', id: view.run.id, step: true });
    case 'retryStage': return vscode.postMessage({ type: 'retry', id: view.run.id, step: false });
  }
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.card,.node,.stepn,.run-item')) { e.preventDefault(); e.target.click(); }
  if (e.key === 'Escape' && view.mode === 'run') { if (view.step) view.step = null; else view.stage = null; drawRun(); }
});
$('#project').addEventListener('change', (e) => vscode.postMessage({ type: 'project', root: e.target.value }));
let suggestTimer;
document.addEventListener('input', (e) => { if (e.target.id === 'desc' || e.target.id === 'title') { clearTimeout(suggestTimer); suggestTimer = setTimeout(() => { readForm(); vscode.postMessage({ type: 'suggest', text: form.title + ' ' + form.description }); }, 900); } });

window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'state') { S = m; if (view.run) view.run = S.runs.find((r) => r.id === view.run.id) ?? view.run; if (view.mode === 'form' && !form.suggestions.length) vscode.postMessage({ type: 'suggest', text: form.title + ' ' + form.description }); draw(); }
  if (m.type === 'run') { const i = S.runs.findIndex((r) => r.id === m.run.id); if (i >= 0) S.runs[i] = m.run; else S.runs.unshift(m.run); if (m.select) view = { mode: 'run', run: m.run, stage: null, step: null, tab: 'trace' }; if (view.run?.id === m.run.id) view.run = m.run; draw(); }
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
