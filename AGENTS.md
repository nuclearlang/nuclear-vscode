# AGENTS.md — nuclear-vscode

The NuclearLang extension for VS Code: the language server, semantic highlighting, code metrics, the Nuclear workspace, Dragonfly run, debug and devices, the HTTP tool, and the Chernobyl themes. Its `theme/` also generates the themes and icons of the JetBrains and Zed extensions.

This repository is a folder of the NuclearLang working tree (`nuclear/nuclear-vscode`); the platform's rules are the
working tree's `../AGENTS.md` ([nuclear](https://github.com/nuclearlang/nuclear/blob/main/AGENTS.md)) and its state is `../STATUS.md`.

- Context of this repository: [docs/context/editors/vscode.md](docs/context/editors/vscode.md).
- What is inside: `src/` (the client), `syntaxes/`, `themes/`, `icons/`, `theme/` (the palette and the generators), `vendor/` (Atom Material icons, MIT), `scripts/bundle-server.mjs` (bundles `nuclear-lsp` and the dialects), `docs/context/editors/`.
- Checks:

```sh
npm install && npm run compile
npm run theme                         # the themes and icons (also of the sibling extensions)
npm run package                       # the .vsix, with the server and every dialect
(cd .. && cargo test -p nuclear-lsp)  # the server
```
