// Copies what the extension ships besides its own code into server/ (and refreshes the Code Metrics settings):
//   server/nuclear-lsp     the language server (`cargo build --release -p nuclear-lsp` in the nuclear repository)
//   server/dialects/       every dialect of the repository (the server finds them next to its binary)
//   server/defs/           the type definitions those dialects use (found as dialects/../defs)
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCodeMetricsSettings } from './codemetrics-settings.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, '..');
// the working tree's root (plan 006): the `nuclear` repository, with nuclear-lsp in its workspace
const repo = join(ext, '..');
const editors = repo;
const exe = process.platform === 'win32' ? 'nuclear-lsp.exe' : 'nuclear-lsp';

execFileSync('cargo', ['build', '--release', '-p', 'nuclear-lsp'], { cwd: editors, stdio: 'inherit' });
// the Code Metrics settings of package.json come from the server's defaults
writeCodeMetricsSettings();

const out = join(ext, 'server');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(editors, 'target', 'release', exe), join(out, exe));
chmodSync(join(out, exe), 0o755);
// every dialect and its definitions, from each source root of the working tree (plan 006): the nuclear repository
// and the platform repositories inside it (dragonfly-*), merged
const roots = [repo, ...readdirSync(repo).filter(n => n === 'dragonfly' || n.startsWith('dragonfly-')).map(n => join(repo, n))]
  .filter(r => existsSync(join(r, 'dialects')));
for (const r of roots) {
  for (const d of ['dialects', 'defs']) {
    if (existsSync(join(r, d))) cpSync(join(r, d), join(out, d), { recursive: true });
  }
}
// the bundled server must load its dialects without the repository
execFileSync(join(out, exe), ['--check-bundle'], { stdio: 'inherit' });
console.log('server bundled in', out);
