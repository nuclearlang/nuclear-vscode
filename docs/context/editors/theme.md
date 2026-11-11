---
layer: L3
component: editors
read-when: you change colors, the Chernobyl theme, icons, comment/doc highlighting or code metrics
---

# Theme, icons and code metrics

## Chernobyl theme (`nuclear-vscode/theme/`)

- `palette.json` (`variants`: Chernobyl, Chernobyl Soft), `build.mjs` (themes for VS Code, JetBrains, Zed; the
  generated `nuclear-example.tmLanguage.json`), `icons.mjs`; `vendor/atom-material-icons/` (MIT) is the icon base
  (`theme/vendor-atom-icons.mjs` updates it).
- Chernobyl Soft (the user's variant): slate background, burnt-yellow UI accents and vivid syntax (classes
  violet, variables pink, keywords orange, functions mint green, library functions and operators cyan, enums lemon
  yellow, strings lime). No italics. The user wants vivid, bright colors.
- Semantic token colors: `semanticTokenColors` (VS Code), `DEFAULT_*` keys (JetBrains).
- Comments: doc tags at the start of a comment line (`@tag` → `storage.type.class.jsdoc.nuclear`, `@param` name →
  `variable.other.jsdoc.nuclear`) with roles `docTag`/`docParam`, dimmed (`mix(..., background, 0.55)`): everything
  in a comment looks like a comment. `@example` code (more space after `*` than the tag) is `comment.example.nuclear`
  + `source.nuclear.example`; any theme paints it as a comment and Chernobyl dims it with `comment.example.<scope>`.
- Testing a changed theme: VS Code caches the active theme (`colorThemeData` in
  `~/.config/Code/User/globalStorage/state.vscdb`); *Reload Window* does not refresh it. Quit VS Code completely
  (*File → Exit*) or render a preview with the real tokens (grammar + server).

## Nuclear HTTP tree colors

`theme/build.mjs` sets `nuclearHttp.get/post/put/patch/delete/platform/project/component` from the palette (type,
function, warning, number, error, primary, enumMember, property), so the tree of `vscode/src/http.ts` follows each
variant; `vscode/package.json` contributes the same ids with neutral dark/light defaults for other themes.

## Code metrics

Faithful copy of the CodeMetrics extension (the user asked "copy the same messages"): same setting names,
default costs and English texts; Nuclear nodes mapped to the original TypeScript nodes (`match` = Switch
statement, lambda = Arrow function, `and`/`or` = Binary expression; `if`/`else if` counts like nested TS `if`s).
Computed in the server; clients show the list (`nuclear.showCodeMetricsCodeLensInfo`) and colors
(`nuclear/codeMetrics`, or command `nuclear.codeMetrics` in JetBrains). Editor settings are generated from the
server (`scripts/codemetrics-settings.mjs` from `nuclear-lsp --codemetrics-defaults`): never edit
`nuclear.codemetrics.*` by hand.
