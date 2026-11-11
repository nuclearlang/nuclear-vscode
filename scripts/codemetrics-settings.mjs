// Code metrics settings for the editors, from the single source of truth: `nuclear-lsp --codemetrics-defaults`
// (lsp/src/metrics.rs). Writes:
//   vscode/package.json                                the "Code Metrics" settings (nuclear.codemetrics.*)
//   jetbrains/resources/codemetrics-defaults.json      the defaults the plugin's settings page shows
//
// Usage: node scripts/codemetrics-settings.mjs   (needs target/release/nuclear-lsp of the nuclear repository)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// the working tree's root (plan 006): the server is built there, the extensions are its folders
const editors = join(dirname(fileURLToPath(import.meta.url)), '../..');

export function writeCodeMetricsSettings() {
  const exe = process.platform === 'win32' ? 'nuclear-lsp.exe' : 'nuclear-lsp';
  const raw = execFileSync(join(editors, 'target', 'release', exe), ['--codemetrics-defaults'], { encoding: 'utf8' });
  const defaults = JSON.parse(raw);

  // the JetBrains plugin's copy, when that repository is checked out beside this one
  const jb = join(editors, 'nuclear-jetbrains', 'resources', 'codemetrics-defaults.json');
  if (existsSync(join(editors, 'nuclear-jetbrains'))) {
    mkdirSync(dirname(jb), { recursive: true });
    writeFileSync(jb, JSON.stringify(defaults, null, 2) + '\n');
  }

  const properties = {};
  for (const [name, { default: value, description }] of Object.entries(defaults.basics)) {
    const p = { default: value, description };
    if (typeof value === 'boolean') p.type = 'boolean';
    else if (typeof value === 'number') p.type = 'number';
    else if (Array.isArray(value)) Object.assign(p, { type: 'array', items: { type: 'string' } });
    else p.type = 'string';
    if (name.startsWith('ComplexityColor')) p.format = 'color-hex';
    properties[`nuclear.codemetrics.basics.${name}`] = p;
  }
  for (const [name, { default: cost, description, nuclear }] of Object.entries(defaults.nodeconfiguration)) {
    properties[`nuclear.codemetrics.nodeconfiguration.${name}`] = {
      type: 'number',
      default: cost,
      markdownDescription: `Complexity increment of ${nuclear}`,
    };
    properties[`nuclear.codemetrics.nodeconfiguration.${name}Description`] = {
      type: 'string',
      default: description,
      markdownDescription: `Text of ${nuclear} in the details list`,
    };
  }

  const pkgPath = join(editors, 'nuclear-vscode', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const sections = Array.isArray(pkg.contributes.configuration)
    ? pkg.contributes.configuration
    : [pkg.contributes.configuration];
  const main = sections.find((s) => s.title === 'NuclearLang');
  pkg.contributes.configuration = [main, { title: 'Code Metrics', properties }];
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`code metrics settings: ${Object.keys(properties).length} in package.json, defaults in ${jb}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeCodeMetricsSettings();
