// The project card `.nuclear/project.json`, written by the language server and the CLIs when they build a project
// (spec/projects.md §1.1): its platform, dialect, output folder and toolchain, so the client never assumes a path, a
// port or a command of a dialect.
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ProjectCard {
  name: string;
  platform: string | null;
  dialect: string;
  language: string;
  output: string;
  plugins: string[];
  kinds: Record<string, string>;
  /** `[toolchain]` of the dialect for this system: where the app answers, how to serve it on a chosen port
   * (`{{port}}`, `{{host}}`), what exists in the output once its packages are installed. */
  toolchain?: { url?: string | null; serve?: string | null; installed?: string | null };
}

export const CARD = path.join('.nuclear', 'project.json');

/** The card of the project at `root`. */
export function readCard(root: string): ProjectCard | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, CARD), 'utf8')) as ProjectCard;
  } catch {
    return undefined;
  }
}

/** The card of the project that contains `file`: the closest one up the folders. */
export function projectCard(file: string): ProjectCard | undefined {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    const card = readCard(dir);
    if (card) return card;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/** The generated app of a project (its card's output folder). */
export function appDir(root: string, card = readCard(root)): string | undefined {
  return card ? path.join(root, card.output) : undefined;
}

/** Whether the generated app has its packages (the dialect's `installed` path exists); true when the dialect
 * declares none. */
export function isInstalled(root: string, card = readCard(root)): boolean {
  const app = appDir(root, card);
  const marker = card?.toolchain?.installed;
  return !app || !marker || fs.existsSync(path.join(app, marker));
}
