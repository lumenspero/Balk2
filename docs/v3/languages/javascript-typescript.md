# JavaScript and TypeScript

This page lists what Balk2 recognizes in JavaScript and TypeScript (`.js`, `.jsx`, `.mjs`, `.cjs`,
`.ts`, `.tsx`, `.mts`, `.cts`), how it resolves each form, and where the analysis stops. The
JS/TS cells in `language-parity.md` link here.

## Recognized forms

### Imports and requires

- ES `import` declarations, including `import type`, which sets `typeOnly: true` on its `imports`
  edge. Namespace, default and named imports are all recognized.
- Re-exports produce a file-level `imports` edge. Named re-exports also produce `exports` edges for
  the re-exported names (D9).
- CommonJS `require('m')` with a literal string.
- Dynamic loads, with the load kind in the edge metadata: `import('m')` (`import-expression`), and
  loads through a loader, a `new URL(..)` or a worker. A load whose specifier is not a literal is
  recorded as an unresolved `dynamic-module-specifier` observation, not as an edge.
- A `node:` prefix is removed before matching, so `node:fs` and `fs` name the same module.

### Symbols, owners and calls

- Functions, classes, methods, enums (as `enum` symbols) and nested classes (as `Outer.Inner`).
- Direct calls to named functions, and `new X()` construction.
- Method calls on a receiver whose type the TypeScript checker resolves to a repository class, such
  as `user.save()` where `user` is bound to `new User()`. `super.save()` is recorded the same way.
- Inheritance and implementation (`extends`, `implements`), and type references.

### Shared state

- Module `let` bindings that a function reassigns.
- Named access to the global object, such as `window.x` or `globalThis.x`.
- `module.NAME` and `builtins` assignments.
- Reads and writes of a configured singleton's fields.

### Events, registries and callbacks

- Event calls by method name: `on`, `once`, `emit`, `addEventListener`, `dispatchEvent`, `subscribe`
  and `publish`. The event name comes from a string literal, or from the name of an event object. A
  non-literal name is recorded as an unresolved observation.
- Registry calls, such as `container.set('user', User)`, `container.get('user')`,
  `container.get(UserService)` and `container.resolve<UserService>()`, plus dictionary assignments
  such as `handlers[404] = NotFound`. Parameter injection and decorator registration are read too.
- Functions passed as callbacks to a function configured under `protocols.callbacks`.

### Resources, data and processes

- Imports and configured loader calls for templates, stylesheets and schemas.
- Data lineage through the library APIs in the data catalog (`src/facts/data-catalog.ts`). The entries
  cover `fs`, `fs/promises`, `duckdb` and `sqlite3`. A call is matched only when its callee is bound by
  an import from that module, so a local `read` method never reads a file.
- Process execution through `child_process`: `exec`, `execSync`, `execFile`, `spawn`, `spawnSync` and
  `fork`.

### Packages, bindings and comments

- `package.json` manifests and their dependencies.
- The consumer side of napi-rs bindings: an import from a package whose Rust crate exports `#[napi]`
  items is bound to those exports (see `rust.md`).
- `// balk2:` source annotations on the line above a statement, using the shared grammar.
- Test files are tagged as tests (D5). Syntax errors are reported as diagnostics.

## Resolution rules

- Module specifiers are resolved by the TypeScript module resolver. A `tsconfig.json`, when present,
  supplies its options. Without one, Balk2 uses Node 16 defaults.
- A binding is matched to an import by the checker's symbol, not by its name. A local variable,
  parameter or property with the same name as an import never matches it.
- A receiver's type comes from the checker. Only methods of repository classes are linked.
- A callback is linked only when the configured function name matches and the callback is in the
  configured argument position. The function name is never inferred from its shape.
- Event names: a static name links emitter to listener. The same event name on two receivers does not
  connect them.
- Registry keys are scoped by the identity of their registry. The same key in two registries stays two
  keys.
- A configured protocol entry with a `languages` list applies only to the listed families. An entry
  without one applies to every language that supports the form. An entry tagged only for Python or
  Rust is dropped for JS/TS and reported as a configuration problem.
- A dynamic name, or a receiver whose identity cannot be read, becomes an unresolved observation. It
  does not become a guessed edge.

## Mechanisms

| Mechanism               | Edge types                                          | Notes                                         |
| ----------------------- | --------------------------------------------------- | --------------------------------------------- |
| Module imports          | `imports`                                           | `typeOnly` for `import type`                  |
| Re-exports              | `imports`, `exports`                                | `exports` per re-exported name                |
| Dynamic loads           | `imports` with a load kind, or an observation       | load kind in metadata                         |
| Calls and construction  | `calls`                                             | method calls from the checker's receiver type |
| Inheritance             | `extends`, `implements`                             |                                               |
| Events                  | `emits`, `subscribes`, `unsubscribes`, `dispatches` | receiver must look like an emitter or target  |
| Registries              | `registers`, `resolves`, `routesTo`                 | literal keys only                             |
| Callbacks               | `passesCallback`                                    | repository functions                          |
| Module-level state (D8) | shared-state relationships to a state path          | direct reads and writes                       |
| Resources               | `usesResource`                                      | `metadata.mechanism` is `import` or `loader`  |
| Data lineage            | `reads`, `writes`, `generates`, `consumes`          | resolved catalog APIs only                    |
| Process execution       | `executes`                                          | literal commands                              |
| Packages                | `packageRoot`, `dependsOn`, `declaresModule`        | from `package.json`                           |
| napi consumer           | `calls` with the `napi` mechanism                   | see `rust.md` for confidence                  |

## Limits

- **Global object enumeration.** Enumerating the global object, such as `Object.keys(globalThis)` or
  `for (const k in window)`, names no fixed symbol, so it is not recorded. Named access is recorded.
- **Process execution.** Only top-level imports and `require` reach `child_process`. A `package.json`
  script whose command line contains a shell operator resolves only its first command.
- **Binding edges.** Each `import` statement produces its own binding edges. A cross-module member
  lookup matches a member by name only when that name is unique in the repository.
- **napi impl methods.** Methods in an `impl` block for a `#[napi]` class are not bound to JS.
- **Method receivers.** A receiver whose type the checker cannot resolve is not linked.

## Not applicable

No mechanism in `language-parity.md` is marked Not applicable for JS/TS. The enumeration limit above is
the only case where a form is outside what the analysis records.
