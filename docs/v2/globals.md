# Globals

Browser-style code often shares functions and values without importing them: a script declares
`function init() {}` and another file calls `init()`. Balk2 connects those uses to their
declaration, and says so plainly when it cannot tell which declaration is meant.

## What counts as a global

- **Script declarations.** Top-level functions, classes, variables, enums and namespaces in a file
  that is a _script_: no `import`/`export`, and no `require`, `module.exports` or `exports`. A
  declaration in a module is not global, however it is exported. Files ending in `.mjs`, `.mts`,
  `.cjs` and `.cts` are always modules.
- **Ambient declarations** in a `declare global { ... }` block.
- **Assignments to a global root**: `window.App = ...`, `globalThis.App.Engine = ...`,
  `self.handler = ...`. `=`, `||=` and `??=` establish a global; `+=` and friends only modify one.
  The roots are `globalThis`, `window`, `self` and `global`, and a `const` alias of one
  (`const root = globalThis; root.Shared = ...`) counts.

A name is only a root when it is not a local binding: a parameter called `self`, or a local
`const window = {}`, is not the global object.

An assignment at the top level of a file declares the global. An assignment inside a function is a
write to it; it only declares the global when nothing declares it at the top level (an
`(function () { window.App = {}; })()` wrapper, for example).

## What the map shows

A read of a global from another file becomes a `references` relationship from the using symbol (or
file) to the declaring symbol, plus a file-level one. Each use is recorded as a source span, and the
relationship says how the name was matched: `ts-program` (the compiler resolved it), `ast` (matched
by name against the collected globals) or `config` (you chose it, below).

Writes and reads are tracked separately. A write to a global is recorded but does not create a
relationship, because writing is not depending.

## Duplicated names

If two files declare the same global, a use of the name could mean either. Balk2 does not guess. The
use becomes an **unresolved observation** (`ambiguous-global`), linked from the using symbol by a
low-confidence `references` relationship, and the map lists the candidates:

```
### unresolved:ambiguous-global:main.js:1:25

Reason: ambiguous-global
Subject: init
Detail: "init" is declared in one.js and two.js; choose one with globals.targets
Attempted: references
Location: main.js:1:25
Candidates:
  - one.js:init
  - two.js:init
Observed from:
  ← main.js:run (references)
```

The using symbol's own section links to it, marked `(low confidence)`.

Every use site is its own observation. Writes to a duplicated name are not reported.

## Configuration

`.balk2.json`:

```json
{
  "globals": {
    "roots": ["globalThis", "window"],
    "targets": { "init": "two.js" }
  }
}
```

| Field     | Meaning                                                                                                                                                                                                                       |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roots`   | Identifiers that denote the global object. **Replaces** the defaults, so a Node-only project can drop `self` and `window`. Invalid entries are reported and ignored; a list with no valid entry leaves the defaults in place. |
| `targets` | For a duplicated name, the file that owns it. A use then resolves to that file with `config` evidence and the observation disappears. A path that matches no candidate is ignored.                                            |

Mistakes in this section are described by `loadBalk2ConfigDetailed`, one `{ path, message }` each.

## Known limits

- Aliases are followed only for `const` bindings of a root.
- Assignments through a computed key (`window[name] = ...`) are not collected.
- Interfaces and type aliases declared as globals are not collected.
- A plain `.js` file with no module syntax is treated as a script even in a `"type": "module"`
  package. That suits browser-script repositories.
