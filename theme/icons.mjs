// Generates the icons of the editors from code:
//   vscode/icons/nuc-file.svg                language icon of .nuc (the trefoil glyph)
//   vscode/icons/nuclear.svg                 the Nuclear activity bar container (the glyph as a currentColor mask)
//   vscode/icons/platform-{mobile,web,backend}.svg   the platform of a project tab in the Nuclear workspace
//   vscode/icons/icon.svg, icon.png          extension logo (the detailed trefoil badge)
//   vscode/icon-themes/                      file icon themes "Chernobyl Icons" and "Chernobyl Soft Icons":
//                                            Atom Material Icons (vendor/, MIT) + the Nuclear icons on top
//   jetbrains/resources/icons/nuc.svg, META-INF/pluginIcon.svg
//
// Usage: node theme/icons.mjs   (from editors/; icon.png needs rsvg-convert;
//        vendor/atom-material-icons comes from `node theme/vendor-atom-icons.mjs`)

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// paths from the working tree's root (plan 006): this repository and its siblings nuclear-jetbrains, nuclear-zed
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const palette = JSON.parse(readFileSync(join(root, 'nuclear-vscode/theme/palette.json'), 'utf8'));

function write(rel, text) {
  const path = join(root, rel);
  // a sibling extension that is not checked out next to this one keeps its own committed copy
  if (!existsSync(join(root, rel.split('/')[0]))) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const f = (n) => n.toFixed(2).replace(/\.?0+$/, '');

/** Ring sector centered on `angle` (degrees, 0 = right, clockwise). */
function blade(cx, cy, rOut, rIn, angle, half = 30) {
  const p = (r, a) => [cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)];
  const [x0, y0] = p(rOut, angle - half);
  const [x1, y1] = p(rOut, angle + half);
  const [x2, y2] = p(rIn, angle + half);
  const [x3, y3] = p(rIn, angle - half);
  return `M${f(x0)} ${f(y0)}A${rOut} ${rOut} 0 0 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${rIn} ${rIn} 0 0 0 ${f(x3)} ${f(y3)}Z`;
}

// ---------------------------------------------------------------- file glyph

/**
 * The trefoil as icon themes draw file types: one flat color on a 24×24 grid, sized for 16 px.
 * Three blades and the center dot, with a clear gap between them so it stays readable when small.
 */
function trefoilGlyph(color) {
  const blades = [-90, 30, 150].map((a) => blade(12, 12, 11, 4.4, a)).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24">
  <path fill="${color}" d="${blades}"/>
  <circle fill="${color}" cx="12" cy="12" r="2.2"/>
</svg>
`;
}

// ---------------------------------------------------------------- logo badge

/** The detailed sign (yellow disc, long shadow, two-tone blades): extension and plugin logo only. */
function trefoilBadge() {
  const blades = [-90, 30, 150].map((a) => blade(256, 256, 200, 78, a)).join('');
  const shadow = Array.from({ length: 48 }, (_, i) => `<use href="#sign" x="${(i + 1) * 6}" y="${(i + 1) * 6}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<defs>
  <clipPath id="disc"><circle cx="256" cy="256" r="256"/></clipPath>
  <clipPath id="right"><rect x="256" y="0" width="256" height="512"/></clipPath>
  <g id="sign"><path d="${blades}"/><circle cx="256" cy="256" r="64"/></g>
</defs>
<circle cx="256" cy="256" r="256" fill="#FDD83F"/>
<g clip-path="url(#disc)" fill="#FBBE2C">${shadow}</g>
<path d="${blades}" fill="#37474F"/>
<path d="${blades}" fill="#21303A" clip-path="url(#right)"/>
<circle cx="256" cy="256" r="64" fill="#FFE33D"/>
<circle cx="256" cy="256" r="64" fill="#FFC107" clip-path="url(#right)"/>
<circle cx="256" cy="256" r="42" fill="#37474F"/>
<circle cx="256" cy="256" r="42" fill="#21303A" clip-path="url(#right)"/>
</svg>
`;
}

/** Color of the .nuc glyph in each variant (the language icon uses the first one). */
const glyphColor = (v) => (v.slug === 'chernobyl' ? '#FFD600' : v.base.primary);

const glyph = trefoilGlyph(glyphColor(palette.variants[0]));
write('nuclear-vscode/icons/nuc-file.svg', glyph);
write('nuclear-jetbrains/resources/icons/nuc.svg', glyph);
// the activity bar draws its icons as masks in the theme's color: the glyph with `currentColor`
write('nuclear-vscode/icons/nuclear.svg', trefoilGlyph('currentColor').replace('width="16" height="16"', 'width="24" height="24"'));
// the platform of a project tab in the Nuclear workspace (ADR-0099): a line glyph in the variant's primary color
const PLATFORM_GLYPHS = {
  mobile: '<rect x="6.5" y="2.5" width="11" height="19" rx="2"/><line x1="10" y1="18" x2="14" y2="18"/>',
  web: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="3.8" ry="9"/><line x1="3" y1="12" x2="21" y2="12"/>',
  backend: '<rect x="3.5" y="4.5" width="17" height="6" rx="1.5"/><rect x="3.5" y="13.5" width="17" height="6" rx="1.5"/><circle cx="7" cy="7.5" r=".9" fill="currentColor"/><circle cx="7" cy="16.5" r=".9" fill="currentColor"/>',
};
for (const [platform, body] of Object.entries(PLATFORM_GLYPHS)) {
  const color = palette.variants[0].base.primary;
  write(`nuclear-vscode/icons/platform-${platform}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" style="color:${color}">${body}</svg>\n`);
}
write('nuclear-vscode/icons/icon.svg', trefoilBadge());
write('nuclear-jetbrains/resources/META-INF/pluginIcon.svg', trefoilBadge());
try {
  execFileSync('rsvg-convert', ['-w', '128', '-h', '128', join(root, 'nuclear-vscode/icons/icon.svg'), '-o', join(root, 'nuclear-vscode/icons/icon.png')]);
} catch {
  console.warn('rsvg-convert not found: vscode/icons/icon.png was not regenerated');
}

// ---------------------------------------------------------------- file icon themes

const atomDir = join(root, 'nuclear-vscode/vendor/atom-material-icons');
if (!existsSync(join(atomDir, 'icon-theme.json'))) {
  throw new Error('vendor/atom-material-icons is missing: run `node theme/vendor-atom-icons.mjs`');
}
const atom = JSON.parse(readFileSync(join(atomDir, 'icon-theme.json'), 'utf8'));

// one shared copy of the Atom Material icons for every variant
const themesDir = join(root, 'nuclear-vscode/icon-themes');
rmSync(themesDir, { recursive: true, force: true });
for (const d of ['files', 'folders', 'foldersOpen']) cpSync(join(atomDir, d), join(themesDir, 'atom', d), { recursive: true });
cpSync(join(atomDir, 'LICENSE.md'), join(themesDir, 'atom', 'LICENSE.md'));

/** Generic folder of Atom Material, recolored: its gray `data-themed` fill becomes `color`. */
const recolor = (svg, color) => svg.replace(/fill="#90a4ae"/gi, `fill="${color}"`);

function iconTheme(v) {
  const own = `./${v.slug}`;
  write(`nuclear-vscode/icon-themes/${v.slug}/nuc.svg`, trefoilGlyph(glyphColor(v)));
  for (const [dir, name] of [['folders', 'folder'], ['foldersOpen', 'folder-open']]) {
    write(`nuclear-vscode/icon-themes/${v.slug}/${name}.svg`, recolor(readFileSync(join(atomDir, dir, 'folder.svg'), 'utf8'), v.base.primary));
  }

  const theme = structuredClone(atom);
  delete theme.atomConfig;
  for (const def of Object.values(theme.iconDefinitions)) {
    def.iconPath = def.iconPath.replace('./../dist/', './atom/');
  }
  // the Nuclear icons on top of Atom Material
  theme.iconDefinitions._nuclear = { iconPath: `${own}/nuc.svg` };
  theme.iconDefinitions['folder-folder'] = { iconPath: `${own}/folder.svg` };
  theme.iconDefinitions['folder-folder-open'] = { iconPath: `${own}/folder-open.svg` };
  theme.fileExtensions.nuc = '_nuclear';
  theme.languageIds.nuclear = '_nuclear';
  for (const mode of ['light', 'highContrast']) {
    if (theme[mode]?.fileExtensions) theme[mode].fileExtensions.nuc = '_nuclear';
  }
  write(`nuclear-vscode/icon-themes/${v.slug}-icon-theme.json`, JSON.stringify(theme) + '\n');
}

for (const v of palette.variants) iconTheme(v);
console.log(`icons written (${Object.keys(atom.iconDefinitions).length} Atom Material icons + Nuclear)`);
