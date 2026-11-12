# NuclearLang

**NuclearLang** (`.nuc`) is a minimal language, made to be written by AI agents and read by people. A transpiler
written in Rust turns it into real code of other technologies, like Dart/Flutter or TypeScript. This extension
brings the language server (`nuclear-lsp`), every dialect (flutter, fastapi, nestjs, dart, python, typescript), their type definitions and the
**Chernobyl** theme.

## What we do

You write the idea once in Nuclear and the transpiler generates the code an expert in the target would write:
imports, `@override`, `async`, constructors, `const`/`final` and the formatting. It goes one way only
(`.nuc` → `.dart` / `.ts`): it neither reads nor changes code of the target language.

```nuclear
stateful Counter
  count: int = 0

  increment() void
    setState()
      count = count + 1

  build(context: BuildContext) Widget
    Scaffold(
      body = Center(child = Text('Clicks: ${count}')),
      floatingActionButton = FloatingActionButton(
        onPressed = increment,
        child = Icon(Icons.add),
      ),
    )
```

generates this Dart (the transpiler's real output):

```dart
import 'package:flutter/material.dart';

class Counter extends StatefulWidget {
  const Counter({super.key});

  @override
  State<Counter> createState() => _CounterState();
}

class _CounterState extends State<Counter> {
  int count = 0;

  void increment() {
    setState(() {
      count = count + 1;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(child: Text('Clicks: $count')),
      floatingActionButton: FloatingActionButton(onPressed: increment, child: Icon(Icons.add)),
    );
  }
}
```

## Philosophy

**Golden rule:** performance, speed and readability. Each rule of the language and of each dialect is accepted
only if it meets the three:

- **Performance:** the generated code runs as fast as an expert's hand-written code.
- **Speed:** transpiling is immediate, because only what is needed is read.
- **Readability:** Nuclear code is minimal and is understood effortlessly.

Principles:

1. **The easiest to write.** No `;`, no `{ }` for blocks, no mandatory `return`, `new` or `this.`, no manual
   `async`. Blocks are marked with a 2-space indentation.
2. **One single way to do each thing.** So an agent never hesitates between two equivalent syntaxes.
3. **Familiar before novel.** Types, `=>`, decorators and generics are written as in TypeScript.
4. **Everything is a value**, as in Elixir: `if` and `match` return, and a function's last line is its result.
5. **Clear errors before magic.** No hidden inference: every diagnostic has a code (`N0106`), a position and,
   when possible, a suggested fix.
6. **The language does not change per dialect.** A dialect adds meaning, not grammar.

## How it works

A **dialect** is a declarative folder (TOML + templates) loaded at run time. It defines:

- the **kinds**: header words like `stateless`, `stateful`, `repository` or `controller`, which generate their
  framework's structure;
- the decorators, the architecture rules and the structure of projects;
- how each construct is written in the target language.

Rust decides *what* is emitted and the dialect decides *how* it is written. To support a new framework you create a
dialect, without touching the compiler.

The **type definitions** (`defs/`, generated from the SDK, like `.d.ts`) describe each class of Dart, Flutter and
packages like bloc, dio and go_router. With them the imports are written by themselves, `@override` goes where it
belongs and the editor completes members and arguments.

## Why

AI agents write better when there is less to write and one single way to do it. Nuclear removes the noise of the
target language (imports, boilerplate, `super.key`, `setState(() { })`) without losing performance. What is left
is the logic, shorter to read and to review. The same `.nuc` can target another technology by changing the
dialect.

## Dialects

```
typescript ─► nodejs ─► nestjs
dart ───────► flutter
```

| Dialect | Target | What it adds |
|---|---|---|
| `dart` | Dart | kinds `extension`, `mixin`, `data`; `Result<E, T>` with fpdart |
| `flutter` | Dart + Flutter | `stateless`, `stateful` and the Dragonfly framework: `@screen` (routes, providers, session, ACL), `repository`, `usecase`, `statemanager`, `event`, `component`, `guard` and tests in Nuclear |
| `typescript` | TypeScript | the base language over strict TS |
| `nodejs` | TypeScript for Node.js | Node APIs |
| `nestjs` | NestJS | kinds `controller` and `service` |

The extension brings every dialect of the repository (`flutter`, `fastapi`, `nestjs`, `dart`, `python`,
`typescript`) with their type definitions. A project is checked with the dialect its manifest names (`config.nuc`
with `dragonfly(platform, dialect)`, or `nuclear.toml`): a backend project never sees Flutter's kinds, and the
status bar shows its platform and dialect (`backend · fastapi`), read from the project card `.nuclear/project.json`
the server writes. `nuclear.dialect` only applies to `.nuc` files outside a project. To use a dialect of your own,
add its folder in the `nuclear.dialectPaths` setting; the `<workspace>/dialects` folder is always searched.

## What the extension brings

- **Live diagnostics**, with the same codes as the transpiler, and quick fixes.
- **Semantic highlighting:** kinds, modules, enums, parameters and library names (deprecated ones struck through).
- **Completion:** members of external classes (`Colors.`, `x.`), named arguments (required ones first), methods
  to override, decorators and the arguments of `@screen`.
- **Hover and signature help** from the type definitions, with a link to Flutter's API.
- **Go to definition, references, rename, outline and folding.**
- **Multi-file projects** (`nuclear.toml`, or a folder with `main.nuc` in a Dragonfly project): the names of the
  other files are visible and the architecture rules apply.
- **A Dragonfly project like a Flutter project**, opened with `dragonfly code` or as a folder (`code .`): the
  Flutter extension's device picker, a ▷ Run / Debug button and F5 on a `.nuc` (transpiles and launches the app
  with the `<project> (debug)` configuration of `build/<project>.code-workspace`), and **hot reload on saving a
  `.nuc`** while the app runs. If the Flutter app is created with the window already open, the extension offers to
  reload the window so the devices appear.
- **Debugging the `.nuc`** on every platform: breakpoints in the `.nuc`, the pause highlighted in the `.nuc`,
  F10/F11/Shift+F11 by Nuclear line, variable values in the `.nuc`, the *Nuclear Call Stack* view and *Go to the
  Same Line in the generated code*, under the Dart debugger (mobile; also Dart errors on their `.nuc` line), node
  (nestjs, with source maps), debugpy (fastapi) and Chrome (react, also on the web device). ◉ Debug or F5 with
  `build/<project>.code-workspace`, which `dragonfly build` writes for every platform with its tasks and launch.
- **Backend and web apps reload on save:** saving a `.nuc` runs `dragonfly build` and the running server or page
  takes it (uvicorn `--reload`, `node --watch`, Vite); `nuclear.buildOnSave`.
- **The web device** (▭ Device of a web project): the app beside the code at the size of a desktop, a laptop, a
  tablet or a phone (user agent, touch, rotation, any size), with an address bar, Chrome's DevTools of the page, the
  color scheme, network throttling, no cache, the page's **Console** and **Network**, screenshots and ◉ Debug.
- **The Nuclear workspace** (activity bar, `Ctrl+Alt+N`): one container where everything of Nuclear meets. A vertical
  strip of tabs beside a pane; every tab is a workspace of its own and switching swaps the editor area. The projects
  at the top (`Ctrl+1` … `Ctrl+9`; open another as a tab with `Ctrl+Alt+O`, without touching the VS Code workspace;
  platform glyph + dialect badge): the pane shows its files with the Chernobyl icon theme, and **the actions of its
  platform are the editor title bar's toolbar** (mobile: run, debug, hot reload, device, build, test, check; backend:
  serve, debug, test, build, check, API; web: serve, device, debug, reload, build, test, check; `Ctrl+Alt+R/G/L/B/T/C`). Run, Debug and Device of a
  mobile project opened as a tab first add its folder to the VS Code workspace (the Dart extension runs Flutter only
  there): one reload, then the action continues. The tools at the bottom
  (`Ctrl+Alt+<letter>`). Clicking a tab or an action shows the shortcut that does the same. A welcome page
  (`Ctrl+Alt+W`, and at startup when no editor is open) lists the projects, the tools and the keys.
- **Loop** (`Ctrl+Alt+P`): spec-driven work as a pipeline. The first page is the spec: what you want (a feature, a
  refactor, a bug, tests, a security review, documentation, a diagram), written here or imported from Jira or a GitHub
  issue, its acceptance criteria, the context files the agents get (suggested from the project and your skills) and
  who leads (Claude with the local Nuclear Developer, or the local agents only). A run is drawn like a GitHub pipeline
  that zooms like a C4 diagram: the stages (spec, generate, plan, code, tests, security, artifacts, deploy; *Generate* runs `dragonfly gen` for the
  resources the spec names, so the agents write only what is left), then the steps of a
  stage, then what each agent did (its trace, its code, its output). The commands of each stage are
  `.nuclear/loop.json`; *Export CI* writes them for GitHub Actions, GitLab CI or Bitbucket Pipelines. Needs the
  [Nuclear Smart Graph](https://github.com/nuclearlang/nuclear-graph) and the
  [Nuclear Developer](https://github.com/nuclearlang/nuclear-developer) running. The same engine runs without the
  editor as `nuclear-loop` (`run` a spec file, `ci` the server stages, `export`, `runs`), installed by `./install.sh`.
- **Nuclear agent** (`Ctrl+Alt+A`): a chat with the local agents of the
  [Nuclear Developer](https://github.com/nuclearlang/nuclear-developer), like the chats of Claude or Cursor, over the
  active project and on your machine. Ask anything about the project: the local assistant answers from the project's
  map (`.nuclear/map.md`) and the Smart Graph. Give an order with `/task <what to do>`: the local agents plan it, write
  the tests first, then the code, run the tests and the security review, and their journal is the answer (*Open the
  journal of the run*). The templates above the input are built from the project's own components and use cases;
  every session is kept in the project (`.nuclear/chat/<id>.json`) and listed on the left.
- **Settings and integrations** (`Ctrl+Alt+S`): every setting of the AI loop in one page, kept as the editor's
  `nuclear.ai.*` settings: the services (Smart Graph, Nuclear Developer, Ollama) with their state and *Start* /
  *Restart* with the chosen models; the local models (installed ones with their size, a warning over the 3B rule,
  *Pull*); the Nuclear MCP server added to Claude Code, Codex or Cursor in one click; the connections (the graph's
  clients and pending access requests with *Allow* / *Deny* / *Revoke*, Jira, GitHub); Claude's model and the retry
  policy. A project's `.nuclear/loop.json` still wins for its own pipeline.
- **Work that does not stop, and notifications**: a Loop run or a chat question belongs to the extension, not to its
  page: switch tools or close the page and it keeps working. When it ends (a chat answered, a run passed or failed) a
  notification says so (*Open* goes to that run or session) unless you are looking at it; the Nuclear icon of the
  activity bar shows a badge with the unread ones, each tool's tab its count, and the tool's pane lists them.
- **The chat in detail**: what the agent did is folded in grey under each answer (its steps, how long, how many tokens
  it read); a context meter shows how full the local model's window is (`nuclear.ai.contextTokens`) and tells you to
  start a new session when it is near; ↑ / ↓ in the input go through the questions you asked before; a question that
  failed has *↻ Retry*, an order that failed *↻ Retry from the step that failed*.
- **A run survives the editor**: every run writes a trace log (`.nuclear/loop/runs/<id>.log`), a heartbeat and a ledger
  of the files it writes. Close or crash VS Code in the middle of a run and, when it opens again, the run is found
  interrupted: what its unfinished step wrote is undone and it goes on from that step by itself (a notification says
  so; `nuclear.ai.resumeInterrupted`). A call nothing is working on (the Developer silent, Ollama holding no model) is
  cut and retried; a command that hangs is killed; two windows never run the same run.
- **Every connection is checked**: each run starts with *Check the connections* (the Developer, the Smart Graph,
  Ollama and the models it needs, Claude Code when it leads, free disk), each chat question checks what it needs, and
  every few minutes every integration is checked again (Claude Code, Codex, OpenCode, GitHub, Jira): a notification when
  one stops answering. Every integration is configured in *Settings and integrations* with its default.
- **When a run fails**: a call to the local agents that fails for a passing reason (the service starting, busy, a
  5xx) is retried by itself with exponential backoff and jitter (*Settings*: tries, first wait, longest wait); each
  retry is written in the step's trace. When a stage fails, the local **diagnoser** tells why (the kind of failure by
  rules, the evidence from the compiler or `dragonfly doctor`, the next step), shown on the run and in the chat;
  *↻ Retry* goes on from the step that failed (on the run and on the failed step itself), keeping every step that
  passed; *Restart <stage>* runs the whole stage again (`nuclear-loop retry <run> [--from <stage>]` without the editor).
- **Nuclear HTTP** (`Ctrl+Alt+H`): a workspace like Bruno. Its pane is the endpoints tree of every project by platform,
  project and component (from the contract the compiler writes, `.nuclear/contract.json`), the contracts an app
  declares with *↓ Update* (`nuclear contracts update`), OpenAPI documents of APIs that are not Nuclear, and the
  environment (`.nuclear/http.json`: variables, headers, base urls). A component is an editor tab and each endpoint a
  tab inside it: path and query parameters, headers, a sample body from the model, the pretty-printed response and
  *copy as curl*.
- **Devices** (`Ctrl+Alt+V`): the open Dragonfly devices and *+ New device*: as many as you want at once, like
  emulators, tiled side by side, each with its own size, identity, app and session; ▷ Run, ◉ Debug and ▭ Device ask
  which device to run on (Dragonfly, new, or any Flutter device); a run never replaces a running device. Closing a
  device tab only hides it (the app goes on); ✕ in the Devices workspace ends it now; a device nobody looks at for 30
  minutes ends by itself and a watchdog frees orphan processes. They belong to the mobile workspaces.
- **Show Generated Code:** shows beside it the Dart or TypeScript the file generates.
- **Complexity metrics** per function, like CodeMetrics.
- **Chernobyl and Chernobyl Soft themes**, with file icons.

## Settings

| Setting | What it does |
|---|---|
| `nuclear.buildOnSave` | saving a `.nuc` of a backend or web project runs `dragonfly build` (the server or page reloads by itself); on by default |
| `nuclear.dialect` | the dialect of files outside a project (`flutter` by default; `base` checks only the base language) |
| `nuclear.dialectPaths` | extra folders with dialects |
| `nuclear.server.path` | another `nuclear-lsp` binary (empty: the one the extension brings) |
| `nuclear.workspace.welcome` | the welcome page of the Nuclear workspace at startup (default on) |
| `nuclear.codemetrics.*` | costs and thresholds of the metrics |

Commands (category **Nuclear**): **Show the Nuclear Workspace**, **Go to Project Tab**, **Open a Project as a Tab**,
**Open a Tool**, **Welcome Page**, **Add the Active Project to the VS Code Workspace**, **Run**, **Debug**, **Select
Dialect**, **Show Generated Code**, **Restart Language Server** and the metrics ones.
