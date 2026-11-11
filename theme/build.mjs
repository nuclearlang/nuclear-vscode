// Generates the Chernobyl themes (every variant in theme/palette.json) for every editor:
//   vscode/themes/chernobyl-color-theme.json        (VS Code: workbench + TextMate + semantic tokens)
//   jetbrains/resources/themes/Chernobyl.theme.json  (IntelliJ / Android Studio UI theme)
//   jetbrains/resources/themes/Chernobyl.xml         (IntelliJ / Android Studio editor color scheme)
//   jetbrains/Chernobyl.icls                         (same scheme, for Settings > Color Scheme > Import)
//
// Usage: node theme/build.mjs   (from editors/)

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// paths from the working tree's root (plan 006): this repository and its siblings nuclear-jetbrains, nuclear-zed
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const palette = JSON.parse(readFileSync(join(root, 'nuclear-vscode/theme/palette.json'), 'utf8'));

/** Blend of two "#RRGGBB" colors: t = 0 → a, t = 1 → c. */
const mix = (a, c, t) => '#' + [1, 3, 5].map((i) => {
  const x = parseInt(a.slice(i, i + 2), 16), y = parseInt(c.slice(i, i + 2), 16);
  return Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
}).join('').toUpperCase();

/** "#A7FF00" + alpha 0..1 → "#A7FF00xx" */
const alpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase();

function write(rel, text) {
  const path = join(root, rel);
  // a sibling extension that is not checked out next to this one keeps its own committed copy
  if (!existsSync(join(root, rel.split('/')[0]))) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  console.log('wrote', rel);
}

// ---------------------------------------------------------------- VS Code

/** TextMate scopes of each syntax role (Nuclear grammar + common scopes of other languages). */
const scopes = {
  comment: ['comment', 'punctuation.definition.comment'],
  docTag: ['storage.type.class.jsdoc', 'storage.type.class.doxygen', 'keyword.other.documentation', 'comment keyword.other.documentation'],
  docParam: ['variable.other.jsdoc', 'comment variable.other.jsdoc'],
  keyword: ['keyword', 'keyword.control', 'keyword.other', 'storage.type', 'keyword.operator.word', 'keyword.operator.logical.word'],
  kind: ['storage.type.kind'],
  modifier: ['storage.modifier'],
  selfKeyword: ['variable.language.this', 'variable.language.super', 'variable.language.self'],
  throw: ['keyword.control.throw', 'keyword.control.exception.throw'],
  nullValue: ['constant.language.null', 'constant.language.undefined', 'constant.language.nil'],
  boolean: ['constant.language.boolean'],
  string: ['string', 'string.quoted', 'string.template'],
  stringEscape: ['constant.character.escape'],
  interpolation: ['punctuation.definition.template-expression', 'punctuation.section.embedded', 'punctuation.definition.interpolation'],
  number: ['constant.numeric'],
  function: ['entity.name.function', 'meta.function-call.generic', 'variable.function'],
  libraryFunction: ['support.function'],
  type: ['entity.name.type', 'entity.name.class', 'entity.other.inherited-class', 'support.class', 'support.type', 'storage.type.primitive', 'entity.name.type.class'],
  typeParameter: ['entity.name.type.parameter', 'storage.type.generic'],
  enumMember: ['variable.other.enummember', 'constant.other.enum'],
  property: ['variable.other.property', 'variable.other.object.property', 'support.variable.property', 'meta.object-literal.key', 'variable.parameter.named', 'entity.other.attribute-name'],
  parameter: ['variable.parameter'],
  variable: ['variable', 'variable.other.readwrite', 'meta.definition.variable'],
  decorator: ['meta.decorator', 'entity.name.function.decorator', 'punctuation.decorator', 'storage.type.annotation', 'meta.annotation'],
  operator: ['keyword.operator', 'keyword.operator.arrow', 'storage.type.function.arrow'],
  punctuation: ['punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator'],
  invalid: ['invalid', 'invalid.illegal'],
};

// Some roles must win over broader ones listed earlier (e.g. keyword.operator.word over keyword.operator).
const order = ['punctuation', 'operator', 'variable', 'keyword', 'kind', 'modifier', 'selfKeyword', 'throw',
  'nullValue', 'boolean', 'string', 'stringEscape', 'interpolation', 'number', 'function', 'type', 'typeParameter',
  'enumMember', 'property', 'parameter', 'decorator', 'comment', 'docTag', 'docParam', 'invalid', 'libraryFunction'];

const fontStyle = (r) => [r.italic && 'italic', r.bold && 'bold', r.underline && 'underline'].filter(Boolean).join(' ');

const zedThemes = [];
for (const variant of palette.variants) build(variant);
write('nuclear-zed/themes/chernobyl.json', JSON.stringify({
  $schema: 'https://zed.dev/schema/themes/v0.2.0.json', name: 'Chernobyl', author: 'NuclearLang', themes: zedThemes,
}, null, 2) + '\n');

/** Writes every file of one variant (Chernobyl, Chernobyl Soft). Only the interface changes between variants. */
function build(v) {
const b = v.base;
const name = v.name;
// code colors: the shared `syntax` of the palette, with the variant's own `syntax` on top
const s = { ...palette.syntax, ...(v.syntax ?? {}) };
// functions of a library (Flutter, Dart, the dialect kind): `libraryFunction`, or the function color
s.libraryFunction ??= s.function;
// tags of doc comments (`@param name`): the decorator and parameter colors dimmed toward the background, like
// the code of an `@example`, so everything inside a comment reads as comment
s.docTag ??= { color: mix(s.decorator.color, b.background, 0.55), bold: true };
s.docParam ??= { color: mix(s.parameter.color, b.background, 0.55) };

const tokenColors = order.map((role) => {
  const r = s[role];
  const settings = { foreground: r.color };
  const fs = fontStyle(r);
  settings.fontStyle = fs; // '' resets inherited styles
  return { name: role, scope: scopes[role], settings };
});
// keyword.operator.word (and, or, not, is, in) are words, colored as keywords
tokenColors.push({ name: 'word operators', scope: ['keyword.operator.word', 'keyword.operator.logical.word', 'keyword.operator.expression'], settings: { foreground: s.keyword.color } });
// the code of an `@example` inside a doc comment uses a copy of the grammar whose scopes all start with
// `comment.example.`: any theme shows it as comment (and VS Code treats it as comment: no bracket colors),
// and here it keeps its colors, dimmed toward the background, so it reads as part of the comment
const exampleScope = (sc) => sc.split(' ').map((p) => `comment.example.${p}`).join(' ');
{
  const grammarPath = join(root, 'nuclear-vscode/syntaxes/nuclear.tmLanguage.json');
  const prefix = (o) => {
    if (Array.isArray(o)) return o.forEach(prefix);
    if (!o || typeof o !== 'object') return;
    for (const k of ['name', 'contentName']) if (typeof o[k] === 'string') o[k] = exampleScope(o[k]);
    if (o.include === 'source.nuclear') o.include = '$self';
    Object.values(o).forEach(prefix);
  };
  const g = JSON.parse(readFileSync(grammarPath, 'utf8'));
  delete g.fileTypes;
  g.name = 'Nuclear (code of an @example)';
  g.scopeName = 'source.nuclear.example';
  prefix(g.patterns);
  prefix(g.repository);
  write('nuclear-vscode/syntaxes/nuclear-example.tmLanguage.json', JSON.stringify(g, null, 2) + '\n');
}
const dim = (c) => mix(c, b.background, 0.55);
tokenColors.push({ name: 'example code', scope: ['comment.example'], settings: { foreground: dim(s.variable.color), fontStyle: '' } });
for (const role of order.filter((r) => r !== 'comment' && r !== 'invalid')) {
  const r = s[role];
  tokenColors.push({ name: `example ${role}`, scope: scopes[role].map(exampleScope), settings: { foreground: dim(r.color), fontStyle: fontStyle(r) } });
}
tokenColors.push({ name: 'example word operators', scope: ['keyword.operator.word', 'keyword.operator.logical.word', 'keyword.operator.expression'].map(exampleScope), settings: { foreground: dim(s.keyword.color) } });
// the `*` and the `//` of a comment inside an example stay comment gray
tokenColors.push({ name: 'example comment', scope: scopes.comment.map(exampleScope), settings: { foreground: s.comment.color, fontStyle: fontStyle(s.comment) } });

const sem = (r) => {
  const o = { foreground: r.color };
  if (r.italic) o.italic = true;
  if (r.bold) o.bold = true;
  if (r.underline) o.underline = true;
  return o;
};

const semanticTokenColors = {
  namespace: sem(s.type),
  type: sem(s.type),
  class: sem(s.type),
  enum: sem(s.type),
  interface: sem(s.type),
  struct: sem(s.type),
  typeParameter: sem(s.typeParameter),
  parameter: sem(s.parameter),
  variable: sem(s.variable),
  property: sem(s.property),
  enumMember: sem(s.enumMember),
  function: sem(s.function),
  method: sem(s.function),
  'function.defaultLibrary': sem(s.libraryFunction),
  'method.defaultLibrary': sem(s.libraryFunction),
  macro: sem(s.kind),
  keyword: sem(s.keyword),
  modifier: sem(s.modifier),
  decorator: sem(s.decorator),
  comment: sem(s.comment),
  string: sem(s.string),
  number: sem(s.number),
  operator: sem(s.operator),
  'keyword.kind': sem(s.kind),
  '*.deprecated': { strikethrough: true },
};

// derived interface colors
const selection = mix(b.background, b.primary, 0.28);
const hover = mix(b.background, b.primary, 0.07);
const errorBg = mix(b.background, b.error, 0.15);
const warningBg = mix(b.background, b.warning, 0.12);

const vscodeColors = {
  // base
  focusBorder: alpha(b.primary, 0.6),
  foreground: b.foreground,
  descriptionForeground: b.muted,
  errorForeground: b.error,
  'icon.foreground': b.muted,
  'selection.background': alpha(b.primary, 0.3),
  'widget.shadow': '#00000099',
  'textLink.foreground': b.primary,
  'textLink.activeForeground': b.accent,
  'textPreformat.foreground': b.warning,
  'textBlockQuote.background': b.surfaceLow,
  'textBlockQuote.border': b.primary,
  'textCodeBlock.background': b.surfaceLow,
  'progressBar.background': b.primary,
  'sash.hoverBorder': b.primary,
  // window
  'titleBar.activeBackground': b.backgroundDeep,
  'titleBar.activeForeground': b.foreground,
  'titleBar.inactiveBackground': b.backgroundDeep,
  'titleBar.inactiveForeground': b.faint,
  'titleBar.border': b.border,
  'menu.background': b.surfaceLow,
  'menu.foreground': b.foreground,
  'menu.selectionBackground': alpha(b.primary, 0.18),
  'menu.selectionForeground': b.primary,
  'menu.separatorBackground': b.border,
  'menu.border': b.border,
  'menubar.selectionBackground': alpha(b.primary, 0.12),
  'commandCenter.background': b.surfaceLow,
  'commandCenter.border': b.border,
  'commandCenter.activeBorder': b.primary,
  // activity bar
  'activityBar.background': b.background,
  'activityBar.foreground': b.primary,
  'activityBar.inactiveForeground': b.faint,
  'activityBar.border': b.border,
  'activityBar.activeBorder': b.primary,
  'activityBar.activeBackground': alpha(b.primary, 0.08),
  'activityBar.activeFocusBorder': b.primary,
  'activityBarBadge.background': b.primary,
  'activityBarBadge.foreground': b.background,
  // side bar
  'sideBar.background': b.backgroundDeep,
  'sideBar.foreground': b.foreground,
  'sideBar.border': b.border,
  'sideBarTitle.foreground': b.muted,
  'sideBarSectionHeader.background': b.backgroundDeep,
  'sideBarSectionHeader.foreground': b.foreground,
  'sideBarSectionHeader.border': b.border,
  'list.activeSelectionBackground': alpha(b.primary, 0.14),
  'list.activeSelectionForeground': b.primary,
  'list.inactiveSelectionBackground': b.surface,
  'list.inactiveSelectionForeground': b.foreground,
  'list.hoverBackground': alpha(b.primary, 0.06),
  'list.hoverForeground': b.foreground,
  'list.focusOutline': alpha(b.primary, 0.5),
  'list.highlightForeground': b.primary,
  // files and folders with problems in the explorer: `listError` (softer), or the error color
  'list.errorForeground': b.listError ?? b.error,
  'list.warningForeground': b.warning,
  'tree.indentGuidesStroke': b.border,
  'tree.inactiveIndentGuidesStroke': alpha(b.border, 0.6),
  // editor groups and tabs
  'editorGroup.border': b.border,
  'editorGroupHeader.tabsBackground': b.backgroundDeep,
  'editorGroupHeader.tabsBorder': b.border,
  'tab.activeBackground': b.background,
  'tab.activeForeground': b.foreground,
  'tab.activeBorder': b.primary,
  'tab.activeBorderTop': '#00000000',
  'tab.inactiveBackground': b.backgroundDeep,
  'tab.inactiveForeground': b.faint,
  'tab.hoverBackground': b.surfaceLow,
  'tab.border': b.border,
  'tab.unfocusedActiveBorder': alpha(b.primary, 0.4),
  'tab.unfocusedActiveForeground': b.muted,
  'breadcrumb.background': b.background,
  'breadcrumb.foreground': b.muted,
  'breadcrumb.focusForeground': b.foreground,
  'breadcrumb.activeSelectionForeground': b.primary,
  // editor
  'editor.background': b.background,
  'editor.foreground': b.foreground,
  'editorCursor.foreground': b.primary,
  'editor.lineHighlightBackground': alpha(b.surface, 0.7),
  'editor.lineHighlightBorder': '#00000000',
  'editorLineNumber.foreground': b.faint,
  'editorLineNumber.activeForeground': b.primary,
  'editor.selectionBackground': alpha(b.primary, 0.25),
  'editor.inactiveSelectionBackground': alpha(b.primary, 0.12),
  'editor.selectionHighlightBackground': alpha(b.primary, 0.12),
  'editor.wordHighlightBackground': alpha(b.accent, 0.14),
  'editor.wordHighlightStrongBackground': alpha(b.warning, 0.16),
  'editor.findMatchBackground': alpha(b.warning, 0.35),
  'editor.findMatchHighlightBackground': alpha(b.warning, 0.16),
  'editor.findMatchBorder': b.warning,
  'editor.rangeHighlightBackground': alpha(b.primary, 0.06),
  'editorIndentGuide.background1': b.border,
  'editorIndentGuide.activeBackground1': alpha(b.primary, 0.55),
  'editorWhitespace.foreground': alpha(b.faint, 0.6),
  'editorRuler.foreground': b.border,
  'editorBracketMatch.background': alpha(b.primary, 0.15),
  'editorBracketMatch.border': alpha(b.primary, 0.7),
  'editorBracketHighlight.foreground1': b.primary,
  'editorBracketHighlight.foreground2': s.function.color,
  'editorBracketHighlight.foreground3': b.warning,
  'editorBracketHighlight.foreground4': s.property.color,
  'editorBracketHighlight.foreground5': b.accent,
  'editorBracketHighlight.foreground6': s.enumMember.color,
  'editorBracketHighlight.unexpectedBracket.foreground': b.error,
  'editorError.foreground': b.error,
  // the Nuclear HTTP tree (vscode/src/http.ts): verbs, platforms, projects and components in the palette's colors
  'nuclearHttp.get': s.type.color,
  'nuclearHttp.post': s.function.color,
  'nuclearHttp.put': b.warning,
  'nuclearHttp.patch': s.number.color,
  'nuclearHttp.delete': b.error,
  'nuclearHttp.platform': b.primary,
  'nuclearHttp.project': s.enumMember.color,
  'nuclearHttp.component': s.property.color,
  'editorWarning.foreground': b.warning,
  'editorInfo.foreground': b.info,
  'editorHint.foreground': b.primary,
  'editorGutter.background': b.background,
  'editorGutter.addedBackground': b.accent,
  'editorGutter.modifiedBackground': b.warning,
  'editorGutter.deletedBackground': b.error,
  'editorCodeLens.foreground': b.faint,
  'editorInlayHint.background': alpha(b.surface, 0.8),
  'editorInlayHint.foreground': b.muted,
  'editorOverviewRuler.border': b.border,
  'editorOverviewRuler.errorForeground': b.error,
  'editorOverviewRuler.warningForeground': b.warning,
  'editorWidget.background': b.surfaceLow,
  'editorWidget.border': b.border,
  'editorSuggestWidget.background': b.surfaceLow,
  'editorSuggestWidget.border': b.border,
  'editorSuggestWidget.selectedBackground': alpha(b.primary, 0.16),
  'editorSuggestWidget.highlightForeground': b.primary,
  'editorSuggestWidget.focusHighlightForeground': b.primary,
  'editorHoverWidget.background': b.surfaceLow,
  'editorHoverWidget.border': b.border,
  'editorStickyScroll.background': b.background,
  'editorStickyScrollHover.background': b.surface,
  'peekView.border': b.primary,
  'peekViewEditor.background': b.backgroundDeep,
  'peekViewResult.background': b.surfaceLow,
  'peekViewTitle.background': b.surfaceLow,
  'peekViewResult.selectionBackground': alpha(b.primary, 0.16),
  'peekViewEditor.matchHighlightBackground': alpha(b.warning, 0.25),
  'minimap.background': b.background,
  'minimap.selectionHighlight': alpha(b.primary, 0.4),
  'minimapSlider.background': alpha(b.primary, 0.08),
  'minimapSlider.hoverBackground': alpha(b.primary, 0.14),
  'scrollbarSlider.background': alpha(b.faint, 0.35),
  'scrollbarSlider.hoverBackground': alpha(b.faint, 0.55),
  'scrollbarSlider.activeBackground': alpha(b.primary, 0.4),
  'scrollbar.shadow': '#00000080',
  // inputs and buttons
  'input.background': b.surfaceLow,
  'input.foreground': b.foreground,
  'input.border': b.border,
  'input.placeholderForeground': b.faint,
  'inputOption.activeBorder': b.primary,
  'inputOption.activeBackground': alpha(b.primary, 0.15),
  'inputValidation.errorBackground': errorBg,
  'inputValidation.errorBorder': b.error,
  'inputValidation.warningBackground': warningBg,
  'inputValidation.warningBorder': b.warning,
  'dropdown.background': b.surfaceLow,
  'dropdown.border': b.border,
  'dropdown.foreground': b.foreground,
  'button.background': b.primary,
  'button.foreground': b.background,
  'button.hoverBackground': b.accent,
  'button.secondaryBackground': b.surface,
  'button.secondaryForeground': b.foreground,
  'button.secondaryHoverBackground': b.border,
  'checkbox.background': b.surfaceLow,
  'checkbox.border': b.border,
  'checkbox.foreground': b.primary,
  'badge.background': b.primary,
  'badge.foreground': b.background,
  'keybindingLabel.background': b.surface,
  'keybindingLabel.foreground': b.foreground,
  'keybindingLabel.border': b.border,
  'quickInput.background': b.surfaceLow,
  'quickInputList.focusBackground': alpha(b.primary, 0.16),
  'quickInputList.focusForeground': b.primary,
  'pickerGroup.foreground': b.primary,
  'pickerGroup.border': b.border,
  'notifications.background': b.surfaceLow,
  'notifications.border': b.border,
  'notificationCenterHeader.background': b.surface,
  'notificationsErrorIcon.foreground': b.error,
  'notificationsWarningIcon.foreground': b.warning,
  'notificationsInfoIcon.foreground': b.info,
  // panel, terminal, status bar
  'panel.background': b.backgroundDeep,
  'panel.border': b.border,
  'panelTitle.activeBorder': b.primary,
  'panelTitle.activeForeground': b.foreground,
  'panelTitle.inactiveForeground': b.faint,
  'statusBar.background': b.backgroundDeep,
  'statusBar.foreground': b.muted,
  'statusBar.border': b.border,
  'statusBar.debuggingBackground': b.warning,
  'statusBar.debuggingForeground': b.background,
  'statusBar.noFolderBackground': b.backgroundDeep,
  'statusBarItem.remoteBackground': b.primary,
  'statusBarItem.remoteForeground': b.background,
  'statusBarItem.hoverBackground': alpha(b.primary, 0.12),
  'statusBarItem.errorBackground': b.error,
  'statusBarItem.warningBackground': b.warning,
  'statusBarItem.warningForeground': b.background,
  'terminal.background': b.backgroundDeep,
  'terminal.foreground': b.foreground,
  'terminalCursor.foreground': b.primary,
  'terminal.selectionBackground': alpha(b.primary, 0.25),
  'terminal.ansiBlack': b.background,
  'terminal.ansiRed': b.error,
  'terminal.ansiGreen': b.primary,
  'terminal.ansiYellow': b.warning,
  'terminal.ansiBlue': '#4FA8FF',
  'terminal.ansiMagenta': '#D58CFF',
  'terminal.ansiCyan': b.info,
  'terminal.ansiWhite': b.foreground,
  'terminal.ansiBrightBlack': b.faint,
  'terminal.ansiBrightRed': '#FF7A7A',
  'terminal.ansiBrightGreen': b.accent,
  'terminal.ansiBrightYellow': '#FFE45C',
  'terminal.ansiBrightBlue': '#7CC0FF',
  'terminal.ansiBrightMagenta': '#E5B0FF',
  'terminal.ansiBrightCyan': '#7FF0FA',
  'terminal.ansiBrightWhite': '#F2F8EE',
  // git and diff
  'gitDecoration.addedResourceForeground': b.accent,
  'gitDecoration.modifiedResourceForeground': b.warning,
  'gitDecoration.deletedResourceForeground': b.error,
  'gitDecoration.untrackedResourceForeground': b.primary,
  'gitDecoration.ignoredResourceForeground': b.faint,
  'gitDecoration.conflictingResourceForeground': '#FF9A3C',
  'diffEditor.insertedTextBackground': alpha(b.accent, 0.12),
  'diffEditor.removedTextBackground': alpha(b.error, 0.14),
  'merge.currentHeaderBackground': alpha(b.accent, 0.3),
  'merge.incomingHeaderBackground': alpha(b.info, 0.3),
  // welcome, debug, settings
  'welcomePage.tileBackground': b.surfaceLow,
  'debugToolBar.background': b.surface,
  'debugIcon.breakpointForeground': b.error,
  'settings.headerForeground': b.foreground,
  'settings.modifiedItemIndicator': b.primary,
};

const vscodeTheme = {
  $schema: 'vscode://schemas/color-theme',
  name: name,
  type: 'dark',
  semanticHighlighting: true,
  colors: vscodeColors,
  tokenColors,
  semanticTokenColors,
};
write(`nuclear-vscode/themes/${v.slug}-color-theme.json`, JSON.stringify(vscodeTheme, null, 2) + '\n');

// ---------------------------------------------------------------- Zed
// Zed highlight captures (zed/languages/nuclear/highlights.scm and semantic_token_rules.json) of each role
const zedSyntax = {
  comment: 'comment', 'comment.doc': 'comment', keyword: 'keyword', 'keyword.kind': 'kind', 'keyword.modifier': 'modifier',
  'variable.special': 'selfKeyword', 'constant.builtin': 'nullValue', constant: 'enumMember', boolean: 'boolean',
  string: 'string', 'string.escape': 'stringEscape', 'string.special': 'stringEscape', 'punctuation.special': 'interpolation',
  number: 'number', function: 'function', 'function.builtin': 'libraryFunction', type: 'type', 'type.builtin': 'type',
  constructor: 'type', enum: 'type', 'type.parameter': 'typeParameter', variant: 'enumMember', property: 'property',
  'variable.parameter': 'parameter', variable: 'variable', attribute: 'decorator', operator: 'operator',
  punctuation: 'punctuation', 'punctuation.bracket': 'punctuation', 'punctuation.delimiter': 'punctuation',
  // other languages opened in Zed with this theme
  tag: 'type', label: 'decorator', preproc: 'keyword', embedded: 'variable', title: 'kind', link_uri: 'string',
  link_text: 'function', 'text.literal': 'string', emphasis: 'parameter', 'emphasis.strong': 'kind',
};
const zedStyle = (r) => ({ color: r.color, font_style: r.italic ? 'italic' : null, font_weight: r.bold ? 700 : null });
const syntax = Object.fromEntries(Object.entries(zedSyntax).map(([capture, role]) => [capture, zedStyle(s[role])]));
const ansi = (n) => vscodeColors[`terminal.ansi${n}`];
const status = (name, color) => ({ [name]: color, [`${name}.background`]: alpha(color, 0.12), [`${name}.border`]: alpha(color, 0.5) });
zedThemes.push({
  name,
  appearance: 'dark',
  style: {
    background: b.backgroundDeep,
    border: b.border,
    'border.variant': b.border,
    'border.focused': alpha(b.primary, 0.6),
    'border.selected': b.primary,
    'border.transparent': '#00000000',
    'border.disabled': b.surface,
    'elevated_surface.background': b.surfaceLow,
    'surface.background': b.backgroundDeep,
    'element.background': b.surface,
    'element.hover': alpha(b.primary, 0.08),
    'element.active': alpha(b.primary, 0.18),
    'element.selected': alpha(b.primary, 0.14),
    'element.disabled': b.surfaceLow,
    'drop_target.background': alpha(b.primary, 0.12),
    'ghost_element.background': '#00000000',
    'ghost_element.hover': alpha(b.primary, 0.06),
    'ghost_element.active': alpha(b.primary, 0.14),
    'ghost_element.selected': alpha(b.primary, 0.14),
    'ghost_element.disabled': '#00000000',
    text: b.foreground,
    'text.muted': b.muted,
    'text.placeholder': b.faint,
    'text.disabled': b.faint,
    'text.accent': b.primary,
    icon: b.muted,
    'icon.muted': b.faint,
    'icon.disabled': b.faint,
    'icon.placeholder': b.faint,
    'icon.accent': b.primary,
    'status_bar.background': b.backgroundDeep,
    'title_bar.background': b.backgroundDeep,
    'title_bar.inactive_background': b.backgroundDeep,
    'toolbar.background': b.background,
    'tab_bar.background': b.backgroundDeep,
    'tab.inactive_background': b.backgroundDeep,
    'tab.active_background': b.background,
    'search.match_background': alpha(b.warning, 0.25),
    'panel.background': b.backgroundDeep,
    'panel.focused_border': alpha(b.primary, 0.6),
    'pane.focused_border': alpha(b.primary, 0.4),
    'scrollbar.thumb.background': alpha(b.muted, 0.25),
    'scrollbar.thumb.hover_background': alpha(b.muted, 0.4),
    'scrollbar.thumb.border': '#00000000',
    'scrollbar.track.background': '#00000000',
    'scrollbar.track.border': '#00000000',
    'editor.foreground': b.foreground,
    'editor.background': b.background,
    'editor.gutter.background': b.background,
    'editor.subheader.background': b.surfaceLow,
    'editor.active_line.background': alpha(b.surface, 0.7),
    'editor.highlighted_line.background': alpha(b.surface, 0.9),
    'editor.line_number': b.faint,
    'editor.active_line_number': b.primary,
    'editor.invisible': b.faint,
    'editor.wrap_guide': alpha(b.border, 0.6),
    'editor.active_wrap_guide': b.border,
    'editor.indent_guide': alpha(b.border, 0.6),
    'editor.indent_guide_active': b.faint,
    'editor.document_highlight.read_background': alpha(b.primary, 0.12),
    'editor.document_highlight.write_background': alpha(b.primary, 0.2),
    'terminal.background': b.backgroundDeep,
    'terminal.foreground': b.foreground,
    'terminal.bright_foreground': ansi('BrightWhite'),
    'terminal.dim_foreground': b.muted,
    ...Object.fromEntries(['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'].flatMap((c) => [
      [`terminal.ansi.${c.toLowerCase()}`, ansi(c)],
      [`terminal.ansi.bright_${c.toLowerCase()}`, ansi(`Bright${c}`)],
      [`terminal.ansi.dim_${c.toLowerCase()}`, mix(ansi(c), b.background, 0.4)],
    ])),
    'link_text.hover': b.accent,
    ...status('error', b.error),
    ...status('warning', b.warning),
    ...status('info', b.info),
    ...status('hint', b.muted),
    ...status('success', b.accent),
    ...status('created', b.accent),
    ...status('modified', b.warning),
    ...status('deleted', b.error),
    ...status('conflict', b.error),
    ...status('renamed', b.info),
    ...status('hidden', b.faint),
    ...status('ignored', b.faint),
    ...status('predictive', b.faint),
    ...status('unreachable', b.faint),
    players: [{ cursor: b.primary, background: b.primary, selection: alpha(b.primary, 0.25) }],
    syntax,
  },
});

// ---------------------------------------------------------------- JetBrains: UI theme

const uiTheme = {
  name: name,
  dark: true,
  author: 'NuclearLang',
  editorScheme: `/themes/${v.file}.xml`,
  colors: {
    bg: b.background,
    bgDeep: b.backgroundDeep,
    surface: b.surface,
    surfaceLow: b.surfaceLow,
    border: b.border,
    fg: b.foreground,
    muted: b.muted,
    faint: b.faint,
    primary: b.primary,
    accent: b.accent,
    warning: b.warning,
    error: b.error,
    selection,
    hover,
  },
  ui: {
    '*': {
      background: 'bg',
      foreground: 'fg',
      infoForeground: 'muted',
      disabledForeground: 'faint',
      inactiveForeground: 'faint',
      selectionBackground: 'selection',
      selectionForeground: 'primary',
      selectionInactiveBackground: 'surface',
      selectionBackgroundInactive: 'surface',
      hoverBackground: 'hover',
      borderColor: 'border',
      separatorColor: 'border',
      focusColor: 'primary',
      focusedBorderColor: 'primary',
      underlinedTabBackground: 'bg',
      underlineColor: 'primary',
      lightSelectionBackground: 'hover',
    },
    ActionButton: { hoverBackground: 'hover', pressedBackground: 'selection' },
    Button: {
      startBackground: 'surface', endBackground: 'surface', startBorderColor: 'border', endBorderColor: 'border',
      default: { startBackground: 'primary', endBackground: 'primary', foreground: 'bg', startBorderColor: 'primary', endBorderColor: 'primary', focusedBorderColor: 'accent' },
    },
    ComboBox: { nonEditableBackground: 'surfaceLow', ArrowButton: { background: 'surfaceLow', nonEditableBackground: 'surfaceLow' } },
    TextField: { background: 'surfaceLow' },
    TextArea: { background: 'surfaceLow' },
    EditorPane: { background: 'surfaceLow' },
    Editor: { background: 'bg', foreground: 'fg', shortcutForeground: 'primary', SearchField: { background: 'surfaceLow' } },
    EditorTabs: {
      background: 'bgDeep', underlinedTabBackground: 'bg', underlineColor: 'primary', underlineHeight: 2,
      inactiveUnderlineColor: 'faint', hoverBackground: 'surfaceLow', borderColor: 'border',
    },
    DefaultTabs: { background: 'bgDeep', underlineColor: 'primary', underlinedTabBackground: 'bg', hoverBackground: 'surfaceLow' },
    TabbedPane: { underlineColor: 'primary', focusColor: 'hover', contentAreaColor: 'border' },
    ToolWindow: {
      background: 'bgDeep',
      Header: { background: 'bgDeep', inactiveBackground: 'bgDeep', borderColor: 'border' },
      HeaderTab: { selectedInactiveBackground: 'surface', hoverBackground: 'hover', underlineColor: 'primary' },
      Button: { selectedBackground: 'selection', selectedForeground: 'primary', hoverBackground: 'hover' },
      Stripe: { background: 'bg', borderColor: 'border' },
    },
    MainToolbar: { background: 'bgDeep', inactiveBackground: 'bgDeep', Icon: { hoverBackground: 'hover', pressedBackground: 'selection' } },
    MainWindow: { Tab: { selectedBackground: 'bg', selectedForeground: 'primary', borderColor: 'border' } },
    StatusBar: { background: 'bgDeep', borderColor: 'border', Widget: { hoverBackground: 'hover' }, Breadcrumbs: { foreground: 'muted', hoverBackground: 'hover', selectionForeground: 'primary' } },
    Tree: { background: 'bgDeep', selectionBackground: 'selection', selectionForeground: 'primary', selectionInactiveBackground: 'surface', hoverBackground: 'hover', rowHeight: 24 },
    List: { background: 'bgDeep', selectionBackground: 'selection', selectionForeground: 'primary', selectionInactiveBackground: 'surface', hoverBackground: 'hover' },
    Table: { background: 'bg', selectionBackground: 'selection', stripeColor: 'surfaceLow' },
    Popup: { background: 'surfaceLow', borderColor: 'border', Header: { activeBackground: 'surface', inactiveBackground: 'surfaceLow' }, Separator: { foreground: 'muted' } },
    PopupMenu: { background: 'surfaceLow', selectionBackground: 'selection' },
    Menu: { background: 'surfaceLow', selectionBackground: 'selection', selectionForeground: 'primary', separatorColor: 'border' },
    MenuItem: { selectionBackground: 'selection', selectionForeground: 'primary', acceleratorForeground: 'muted' },
    MenuBar: { borderColor: 'border' },
    CompletionPopup: { background: 'surfaceLow', selectionBackground: 'selection', selectionInactiveBackground: 'surface', matchForeground: 'primary', matchSelectionForeground: 'primary' },
    SearchEverywhere: { Header: { background: 'surfaceLow' }, Tab: { selectedBackground: 'selection', selectedForeground: 'primary' }, SearchField: { background: 'surfaceLow' } },
    ProgressBar: { progressColor: 'primary', indeterminateStartColor: 'accent', indeterminateEndColor: 'primary', passedColor: 'accent', failedColor: 'error', trackColor: 'border' },
    Link: { activeForeground: 'primary', hoverForeground: 'accent', pressedForeground: 'accent', visitedForeground: 'primary' },
    Notification: { background: 'surfaceLow', borderColor: 'border', errorBackground: errorBg, errorBorderColor: 'error', ToolWindow: { informativeBackground: 'surfaceLow', warningBackground: warningBg, errorBackground: errorBg } },
    ValidationTooltip: { errorBackground: errorBg, errorBorderColor: 'error', warningBackground: warningBg, warningBorderColor: 'warning' },
    ToolTip: { background: 'surfaceLow', borderColor: 'border' },
    Counter: { background: 'primary', foreground: 'bg' },
    Checkbox: { Background: { Default: 'surfaceLow', Selected: 'primary' }, Border: { Default: 'border', Selected: 'primary' }, Foreground: { Selected: 'bg' }, Focus: { Wide: 'primary' } },
    Component: { focusColor: 'primary', focusedBorderColor: 'primary', borderColor: 'border', errorFocusColor: 'error', warningFocusColor: 'warning' },
    ScrollBar: { Mac: { thumbColor: b.faint + '80', hoverThumbColor: b.primary + '60' }, thumbColor: b.faint + '80', hoverThumbColor: b.primary + '60' },
    SidePanel: { background: 'bgDeep' },
    Panel: { background: 'bg' },
    Separator: { separatorColor: 'border' },
    Banner: { infoBackground: 'surfaceLow', infoBorderColor: 'border', warningBackground: warningBg, errorBackground: errorBg },
    FileColor: { Green: mix(b.background, s.type.color, 0.1), Yellow: warningBg, Blue: mix(b.background, b.info, 0.1), Rose: errorBg, Orange: mix(b.background, s.property.color, 0.1), Violet: mix(b.background, '#B48CFF', 0.1) },
    Plugins: { Tab: { selectedBackground: 'selection', selectedForeground: 'primary' }, SearchField: { background: 'surfaceLow' } },
  },
  icons: {
    ColorPalette: {
      'Actions.Grey': b.muted, 'Actions.Red': b.error, 'Actions.Yellow': b.warning, 'Actions.Green': b.primary,
      'Actions.Blue': b.info, 'Objects.Green': b.accent, 'Objects.Yellow': b.warning, 'Objects.Red': b.error,
      'Checkbox.Background.Selected.Dark': b.primary, 'Checkbox.Border.Selected.Dark': b.primary, 'Checkbox.Foreground.Selected.Dark': b.background,
    },
  },
};
write(`nuclear-jetbrains/resources/themes/${v.file}.theme.json`, JSON.stringify(uiTheme, null, 2) + '\n');

// ---------------------------------------------------------------- JetBrains: editor color scheme

const hex = (c) => c.replace('#', '').slice(0, 6).toUpperCase();

/** TextAttributesKey → syntax role. LSP semantic tokens and TextMate scopes fall back to DEFAULT_* keys. */
const attrRoles = {
  DEFAULT_KEYWORD: 'keyword',
  DEFAULT_IDENTIFIER: 'variable',
  DEFAULT_NUMBER: 'number',
  DEFAULT_STRING: 'string',
  DEFAULT_VALID_STRING_ESCAPE: 'stringEscape',
  DEFAULT_LINE_COMMENT: 'comment',
  DEFAULT_BLOCK_COMMENT: 'comment',
  DEFAULT_DOC_COMMENT: 'comment',
  DEFAULT_DOC_COMMENT_TAG: 'docTag',
  DEFAULT_DOC_COMMENT_TAG_VALUE: 'docParam',
  DEFAULT_OPERATION_SIGN: 'operator',
  DEFAULT_BRACES: 'punctuation',
  DEFAULT_BRACKETS: 'punctuation',
  DEFAULT_PARENTHS: 'punctuation',
  DEFAULT_COMMA: 'punctuation',
  DEFAULT_DOT: 'punctuation',
  DEFAULT_SEMICOLON: 'punctuation',
  DEFAULT_FUNCTION_DECLARATION: 'function',
  DEFAULT_FUNCTION_CALL: 'function',
  DEFAULT_INSTANCE_METHOD: 'function',
  DEFAULT_STATIC_METHOD: 'function',
  DEFAULT_CLASS_NAME: 'type',
  DEFAULT_CLASS_REFERENCE: 'type',
  DEFAULT_INTERFACE_NAME: 'type',
  DEFAULT_INSTANCE_FIELD: 'property',
  DEFAULT_STATIC_FIELD: 'enumMember',
  DEFAULT_CONSTANT: 'enumMember',
  DEFAULT_LOCAL_VARIABLE: 'variable',
  DEFAULT_REASSIGNED_LOCAL_VARIABLE: 'variable',
  DEFAULT_GLOBAL_VARIABLE: 'variable',
  DEFAULT_PARAMETER: 'parameter',
  DEFAULT_REASSIGNED_PARAMETER: 'parameter',
  DEFAULT_METADATA: 'decorator',
  DEFAULT_PREDEFINED_SYMBOL: 'function',
  DEFAULT_LABEL: 'enumMember',
  DEFAULT_TAG: 'type',
  DEFAULT_ATTRIBUTE: 'property',
  DEFAULT_ENTITY: 'enumMember',
  DEFAULT_TEMPLATE_LANGUAGE_COLOR: 'interpolation',
  // Dart / Flutter files keep the same look
  DART_KEYWORD: 'keyword',
  DART_CLASS: 'type',
  DART_CONSTRUCTOR: 'type',
  DART_ENUM: 'type',
  DART_ENUM_CONSTANT: 'enumMember',
  DART_FUNCTION_TYPE_ALIAS: 'type',
  DART_TYPE_PARAMETER: 'typeParameter',
  DART_ANNOTATION: 'decorator',
  DART_INSTANCE_METHOD_DECLARATION: 'function',
  DART_INSTANCE_METHOD_REFERENCE: 'function',
  DART_STATIC_METHOD_DECLARATION: 'function',
  DART_STATIC_METHOD_REFERENCE: 'function',
  DART_TOP_LEVEL_FUNCTION_DECLARATION: 'function',
  DART_TOP_LEVEL_FUNCTION_REFERENCE: 'function',
  DART_INSTANCE_FIELD_DECLARATION: 'property',
  DART_INSTANCE_FIELD_REFERENCE: 'property',
  DART_INSTANCE_GETTER_DECLARATION: 'property',
  DART_INSTANCE_GETTER_REFERENCE: 'property',
  DART_PARAMETER_DECLARATION: 'parameter',
  DART_PARAMETER_REFERENCE: 'parameter',
  DART_LOCAL_VARIABLE_DECLARATION: 'variable',
  DART_LOCAL_VARIABLE_REFERENCE: 'variable',
  DART_STRING: 'string',
  DART_NUMBER: 'number',
  DART_LINE_COMMENT: 'comment',
  DART_BLOCK_COMMENT: 'comment',
  DART_DOC_COMMENT: 'comment',
};

const raw = (key, opts) =>
  `    <option name="${key}">\n      <value>\n${Object.entries(opts).map(([k, v]) => `        <option name="${k}" value="${v}" />`).join('\n')}\n      </value>\n    </option>\n`;

const attr = (key, role) => {
  const r = s[role];
  const opts = { FOREGROUND: hex(r.color) };
  const fontType = (r.bold ? 1 : 0) | (r.italic ? 2 : 0); // 1 bold, 2 italic
  if (fontType) opts.FONT_TYPE = String(fontType);
  if (r.underline) Object.assign(opts, { EFFECT_COLOR: hex(r.color), EFFECT_TYPE: '1' });
  return raw(key, opts);
};

const colorOpts = {
  CARET_COLOR: b.primary,
  CARET_ROW_COLOR: b.surface,
  SELECTION_BACKGROUND: selection,
  SELECTION_FOREGROUND: '',
  LINE_NUMBERS_COLOR: b.faint,
  LINE_NUMBER_ON_CARET_ROW_COLOR: b.primary,
  GUTTER_BACKGROUND: b.background,
  INDENT_GUIDE: b.border,
  SELECTED_INDENT_GUIDE: mix(b.background, b.primary, 0.55),
  SOFT_WRAP_SIGN_COLOR: b.faint,
  WHITESPACES: mix(b.background, b.faint, 0.5),
  RIGHT_MARGIN_COLOR: b.border,
  METHOD_SEPARATORS_COLOR: b.border,
  TEARLINE_COLOR: b.border,
  SELECTED_TEARLINE_COLOR: b.primary,
  ANNOTATIONS_COLOR: b.muted,
  ADDED_LINES_COLOR: b.accent,
  MODIFIED_LINES_COLOR: b.warning,
  DELETED_LINES_COLOR: b.error,
  CONSOLE_BACKGROUND_KEY: b.backgroundDeep,
  DOCUMENTATION_COLOR: b.surfaceLow,
  ERROR_HINT: errorBg,
  INFORMATION_HINT: b.surfaceLow,
  QUESTION_HINT: b.surfaceLow,
  LOOKUP_COLOR: b.surfaceLow,
  NOTIFICATION_BACKGROUND: b.surfaceLow,
  VISUAL_INDENT_GUIDE: b.border,
  FILESTATUS_ADDED: b.accent,
  FILESTATUS_MODIFIED: b.warning,
  FILESTATUS_DELETED: b.error,
  FILESTATUS_UNKNOWN: b.primary,
};

let scheme = `<scheme name="${name}" version="142" parent_scheme="Darcula">\n`;
scheme += `  <metaInfo>\n    <property name="ide">idea</property>\n    <property name="originalScheme">${name}</property>\n  </metaInfo>\n`;
scheme += '  <colors>\n';
for (const [k, v] of Object.entries(colorOpts)) {
  scheme += `    <option name="${k}" value="${v ? hex(v) : ''}" />\n`;
}
scheme += '  </colors>\n  <attributes>\n';
scheme += raw('TEXT', { FOREGROUND: hex(b.foreground), BACKGROUND: hex(b.background) });
scheme += raw('FOLDED_TEXT_ATTRIBUTES', { FOREGROUND: hex(b.primary), BACKGROUND: hex(mix(b.background, b.primary, 0.1)) });
scheme += raw('MATCHED_BRACE_ATTRIBUTES', { FOREGROUND: hex(b.primary), BACKGROUND: hex(mix(b.background, b.primary, 0.18)), FONT_TYPE: '1' });
scheme += raw('UNMATCHED_BRACE_ATTRIBUTES', { FOREGROUND: hex(b.error), EFFECT_COLOR: hex(b.error), EFFECT_TYPE: '2' });
scheme += raw('IDENTIFIER_UNDER_CARET_ATTRIBUTES', { BACKGROUND: hex(mix(b.background, b.accent, 0.12)), ERROR_STRIPE_COLOR: hex(b.accent) });
scheme += raw('WRITE_IDENTIFIER_UNDER_CARET_ATTRIBUTES', { BACKGROUND: hex(mix(b.background, b.warning, 0.12)), ERROR_STRIPE_COLOR: hex(b.warning) });
scheme += raw('SEARCH_RESULT_ATTRIBUTES', { BACKGROUND: hex(mix(b.background, b.warning, 0.3)), ERROR_STRIPE_COLOR: hex(b.warning) });
scheme += raw('TEXT_SEARCH_RESULT_ATTRIBUTES', { BACKGROUND: hex(mix(b.background, b.warning, 0.3)), ERROR_STRIPE_COLOR: hex(b.warning) });
scheme += raw('ERRORS_ATTRIBUTES', { EFFECT_COLOR: hex(b.error), ERROR_STRIPE_COLOR: hex(b.error), EFFECT_TYPE: '2' });
scheme += raw('WARNING_ATTRIBUTES', { EFFECT_COLOR: hex(b.warning), ERROR_STRIPE_COLOR: hex(b.warning), EFFECT_TYPE: '2' });
scheme += raw('WRONG_REFERENCES_ATTRIBUTES', { FOREGROUND: hex(b.error) });
scheme += raw('NOT_USED_ELEMENT_ATTRIBUTES', { FOREGROUND: hex(b.faint) });
scheme += raw('DEPRECATED_ATTRIBUTES', { EFFECT_COLOR: hex(b.muted), EFFECT_TYPE: '3' });
scheme += raw('INLAY_DEFAULT', { FOREGROUND: hex(b.muted), BACKGROUND: hex(mix(b.background, b.surface, 0.5)) });
scheme += raw('BAD_CHARACTER', { FOREGROUND: hex(b.error), EFFECT_COLOR: hex(b.error), EFFECT_TYPE: '2' });
scheme += raw('HYPERLINK_ATTRIBUTES', { FOREGROUND: hex(b.primary), EFFECT_COLOR: hex(b.primary), EFFECT_TYPE: '1' });
for (const [key, role] of Object.entries(attrRoles)) scheme += attr(key, role);
scheme += '  </attributes>\n</scheme>\n';

write(`nuclear-jetbrains/resources/themes/${v.file}.xml`, scheme);
write(`nuclear-jetbrains/${v.file}.icls`, scheme);
}
