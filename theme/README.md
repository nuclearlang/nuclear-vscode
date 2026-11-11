# The Chernobyl themes


A single source: `theme/palette.json`, with one entry per variant in `variants` (interface and, if the variant
defines it, its code palette). `node theme/build.mjs` generates, for each variant:

- `vscode/themes/<variant>-color-theme.json` (interface + TextMate + semantic tokens)
- `jetbrains/resources/themes/<Variant>.theme.json` (interface)
- `jetbrains/resources/themes/<Variant>.xml` and `jetbrains/<Variant>.icls` (editor)

| Variant | Background | Interface accents |
|---|---|---|
| Chernobyl | `#0B0F0B` almost black | radioactive green `#A7FF00` |
| Chernobyl Soft | `#151D1A` greenish slate (lighter) | burnt yellow `#E0A526` |

## Icons

`node theme/icons.mjs` generates:

- The `.nuc` icon: a flat single-color trefoil on a 24 grid, like the icons of icon themes (yellow in Chernobyl,
  burnt yellow in Soft). The detailed trefoil (a yellow disc with a shadow) is only the logo of the extension and
  the plugin. In Android Studio the trefoil beats icon plugins like Atom Material Icons (which maps `.nuc` to
  Nuclide).
- The VS Code icon themes **Chernobyl Icons** and **Chernobyl Soft Icons**: every icon and association of **Atom
  Material Icons** (MIT; Flutter, Dart, `pubspec.yaml`, folders `android/`, `lib/`...) plus the trefoil for `.nuc`
  and the generic folder in the variant's color.

Atom Material is copied in `vendor/atom-material-icons/` (`node theme/vendor-atom-icons.mjs` updates it from the
installed extension). Credits in `vscode/THIRD-PARTY.md`.

## Code colors

Each variant can have its own code palette (`syntax` inside the variant, over the common `syntax`).

| Role | Chernobyl | Chernobyl Soft | Example |
|---|---|---|---|
| Normal text, punctuation, `${ }` | `#D9E4D2` | `#ECECEC` | `( ) , :` |
| Variable, property, parameter | `#D9E4D2` / `#FF8A3D` | `#FF6AC1` pink | `list`, `characters`, `title =` |
| Reserved word, kind, modifier | `#A7FF00` | `#FFAA00` orange | `if`, `return`, `stateless` |
| Number, escape | `#FFB347` | `#FF9F5A` | `42`, `\n` |
| Type, widget | `#64FF00` | `#C39BFF` violet | `Scaffold`, `Status` |
| Enum item, `true`/`false`/`null` | `#9CF0C8` | `#F4FF7A` lemon yellow | `alive`, `true` |
| Own function | `#2FE0F0` | `#4DFFB4` mint green | `load()`, `getCharacter` |
| Library function, operator, decorator | `#2FE0F0` / `#8FD400` | `#00E5FF` cyan | `runApp`, `setState`, `=`, `@Get` |
| String | `#FFD600` | `#B7F55A` lime green | `'Hello'` |
| Comment | `#5F6E5F` italic | `#9AA4B8` | `// …` |

Chernobyl Soft uses no italics.
