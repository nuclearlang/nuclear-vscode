# Contributing to the NuclearLang VS Code extension

## Build

```sh
# inside the nuclear working tree: nuclear/nuclear-vscode (the server is built from ../crates/nuclear-lsp)
npm install
npm run package                # → nuclearlang-<version>.vsix (server, dialects and defs/dart)
code --install-extension nuclearlang-<version>.vsix
```

To develop: open this folder in VS Code and press F5. Without a packaged binary, the extension uses
`../target/release/nuclear-lsp`. Then: *Preferences: Color Theme* → **Chernobyl**.

A Dragonfly project works like a Flutter project, opened with `dragonfly code` or as a folder (`code .`): the
extension reads `build/<project>.code-workspace`. There is a device picker (Flutter extension), the ▷ button of a
`.nuc` has **Run** and **Debug**, and F5 works without `launch.json`: the three run `dragonfly build` and launch
the `<project> (debug)` config. **Ctrl+S on a `.nuc`** with the app running transpiles and hot reloads. If the
Flutter app is created with the window already open, the extension offers *Reload Window* so the devices appear.
`./install.sh` of the nuclear repository installs the newest `.vsix` of this folder.

Settings: `nuclear.dialect` (`flutter` | `base`), `nuclear.dialectPaths`, `nuclear.server.path`,
`nuclear.trace.server`. The active dialect shows in the status bar; a click changes it.


The themes and icons of the three extensions come from `theme/` (`npm run theme`; `theme/README.md`); the server
tests run in the nuclear repository (`cargo test -p nuclear-lsp`).
