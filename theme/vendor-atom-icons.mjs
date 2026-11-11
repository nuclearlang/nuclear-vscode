// Copies Atom Material Icons (MIT, github.com/AtomMaterialUI/a-file-icon-vscode) into vendor/atom-material-icons/.
// The Chernobyl icon themes reuse its icons and associations (Flutter, Dart, folders...) and only add their own.
//
// Usage: node theme/vendor-atom-icons.mjs [path to the installed extension]
//        (default: the newest ~/.vscode/extensions/atommaterial.a-file-icon-vscode-*)
import { cpSync, existsSync, readdirSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let src = process.argv[2];
if (!src) {
  const dir = join(homedir(), '.vscode', 'extensions');
  const found = readdirSync(dir).filter((d) => d.startsWith('atommaterial.a-file-icon-vscode-')).sort();
  if (!found.length) throw new Error('Atom Material Icons is not installed; pass its path');
  src = join(dir, found.at(-1));
}
const out = join(root, 'vendor', 'atom-material-icons'); // root: this repository
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const d of ['files', 'folders', 'foldersOpen']) cpSync(join(src, 'dist', d), join(out, d), { recursive: true });
cpSync(join(src, 'dist', 'a-file-icon-vscode-icon-theme.json'), join(out, 'icon-theme.json'));
cpSync(join(src, 'LICENSE.md'), join(out, 'LICENSE.md'));
const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version;
writeFileSync(join(out, 'VERSION'), `a-file-icon-vscode ${version}\n`);
console.log(`vendored Atom Material Icons ${version} → ${out}`, existsSync(out));
