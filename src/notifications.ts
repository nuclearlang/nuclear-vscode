// The notifications of the extension: what the local agents did while you were elsewhere (a chat answered, a Loop run
// passed, failed or needs you). Each one is a toast with *Open* (unless you are looking at that tool), a count on the
// tool's tab of the Nuclear strip and a badge on the strip's icon in the activity bar; opening the tool reads them.
import * as vscode from 'vscode';

export type NoticeTool = 'agent' | 'loop' | 'settings';

export interface Notice {
  id: number;
  tool: NoticeTool;
  title: string;
  text: string;
  level: 'info' | 'warning' | 'error';
  at: number;
  read: boolean;
  /** What *Open* shows: the project and, for a run or a session, its id. */
  root?: string;
  ref?: string;
}

class Notices {
  private list: Notice[] = [];
  private next = 1;
  /** The tools on screen now (their panel visible and active): what they say is read at once. */
  private readonly watching = new Set<NoticeTool>();
  readonly onDidChange = new vscode.EventEmitter<void>();
  /** Opens a tool on a notice (set by the workspace: `nuclear.workspace.tool` + the panel's own selection). */
  open: (n: Notice) => void = (n) => void vscode.commands.executeCommand('nuclear.workspace.tool', n.tool);

  all(): readonly Notice[] {
    return this.list;
  }

  unread(tool?: NoticeTool): number {
    return this.list.filter((n) => !n.read && (!tool || n.tool === tool)).length;
  }

  /** A panel tells whether it is on screen; when it is, its notices are read. */
  watch(tool: NoticeTool, visible: boolean): void {
    if (visible) this.watching.add(tool);
    else this.watching.delete(tool);
    if (visible) this.read(tool);
  }

  read(tool: NoticeTool): void {
    let changed = false;
    for (const n of this.list) if (n.tool === tool && !n.read) changed = n.read = true;
    if (changed) this.onDidChange.fire();
  }

  add(n: Omit<Notice, 'id' | 'at' | 'read'>): void {
    const seen = this.watching.has(n.tool);
    const notice: Notice = { ...n, id: this.next++, at: Date.now(), read: seen };
    this.list = [notice, ...this.list].slice(0, 50);
    this.onDidChange.fire();
    if (seen) return;
    const show = n.level === 'error' ? vscode.window.showErrorMessage : n.level === 'warning' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    void show(`${n.title}: ${n.text}`, 'Open').then((pick) => pick === 'Open' && this.open(notice));
  }
}

export const notices = new Notices();
