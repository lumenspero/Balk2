# Balk2 V3 Phase 0 Contract

Status: **Decided.** D1–D9 are settled, and the pending-marker gating rule is approved. Phase 1 starts once the Phase 0 tests are green on the user's machine.

## Product Outcome

JavaScript/TypeScript, Python and Rust are equally supported languages. The same graph contract, mechanism families, accuracy budgets and release gates apply to each. The authoritative per-mechanism status is `docs/v3/language-parity.md`.

## Current Package Snapshot

Observed at commit `35ba930` (package `@lumenspero/balk2` 2.0.1):

- Runtime: ESM and CJS builds, selected through the `exports` map. Node `>=18`.
- Only runtime dependency: `typescript`.
- CLI: `balk2` → `dist/cli.js`.
- Languages analyzed today: JS/TS (`JsTsAnalyzer`, whole-repository through `RepositoryProgram`) and Python (`PythonAnalyzer`, per-file, line-based regex).
- Rust: not analyzed.
- Connection map: `version: 2`.
- CI matrix: Node 18, 20, 22 on `ubuntu-latest` only.

## Decisions

| ID  | Decision                           | Status                | Summary                                                                                                                                                              |
| --- | ---------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Parsers for Python and Rust        | **Decided: A**        | Hand-written TypeScript tokenizers and parsers. Synchronous, no dependencies, same behavior on every platform.                                                       |
| D2  | TOML parsing                       | **Decided: A**        | Add one small synchronous TOML parser as a runtime dependency. Verified from the packed tarball.                                                                     |
| D3  | Versioning                         | **Decided: A**        | Connection map `version: 3`, package `3.0.0`, config `version` accepts `2` or `3`.                                                                                   |
| D4  | Package representation             | **Decided: A**        | One `package` node kind for npm, Python and Cargo.                                                                                                                   |
| D5  | Test code                          | **Decided: A**        | Analyzed and tagged in every language. `include.tests: false` excludes it for all languages.                                                                         |
| D6  | Method naming                      | **Decided: A**        | `Type.method` for class and inherent methods. Rust trait impls use `Type[Trait].method`. Nested classes use `Outer.Inner`.                                           |
| D7  | Shared detectors                   | **Decided: A**        | JS/TS detectors move onto the facts layer, one family at a time, each gated by zero-diff snapshots. B is the fallback only for a family that cannot reach zero diff. |
| D8  | Module-level state                 | **Decided: A**        | A module-level binding reassigned inside a function is state in every language. JS/TS gains new edges, listed in the release notes.                                  |
| D9  | Re-exports produce `exports` edges | **Decided: approved** | Keep the file-level `imports` edge and add an `exports` edge for each re-exported name, in all three languages. Changes JS/TS output, listed in the release notes.   |

All of D1–D8 were confirmed by the user. D9 (re-exports) is approved.

## Inventory of Current JS/TS Behavior (Phase 0.3)

Verified against `src/analyzer/js-ts-analyzer.ts`, `owner.ts`, `global-symbols.ts` and `registry-*.ts`. Each item says what the shared representation becomes. Where the plan assumed a representation that does not exist today, the difference is marked **Change**.

| Concern                                                       | Current JS/TS behavior                                                                                                                                          | V3 shared representation                                                                                                                                                                                                           |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Re-exports (`export { a } from './x'`, `export * from './x'`) | Adds one file→file `imports` edge. No `exports` edge is recorded for the re-exported names.                                                                     | **Change (proposed, D9):** keep the file-level `imports` edge, and add an `exports` edge from the re-exporting file to each re-exported symbol. Python `__init__.py` and Rust `pub use` use the same rule. Confirm before Phase 5. |
| Type-only imports (`import type`)                             | Recorded as an ordinary `imports` edge. Not distinguished.                                                                                                      | **Change:** `imports` carries `metadata.typeOnly: true` for `import type`, TS `TYPE_CHECKING` in Python, and type-only Rust uses where applicable.                                                                                 |
| Enums                                                         | JsTsAnalyzer records no enum symbol. `global-symbols.ts` collects enums only for the global index.                                                              | **Change:** an `enum` symbol type is added, and JS/TS enums become symbols in every language. Listed in the release notes.                                                                                                         |
| Interfaces and type aliases                                   | Recorded as symbols of type `type`.                                                                                                                             | Unchanged. Rust `type` aliases use `type` too.                                                                                                                                                                                     |
| Owners                                                        | `ownerOf` covers named function declarations, class declarations, methods of top-level classes, and variables initialized with an arrow or function expression. | Shared owner rule. Nested-class methods and object-literal methods are **Change**: they gain owners in every language.                                                                                                             |
| Nested classes                                                | Not recorded as `Outer.Inner`.                                                                                                                                  | **Change:** named `Outer.Inner` per D6.                                                                                                                                                                                            |
| Decorators                                                    | Registration decorators (`RegistryDecoratorRule`) and parameter decorators (`RegistryParameterDecoratorRule`) are read from configured names.                   | Decorator facts move to the shared facts layer. Python decorators and Rust attributes use the same configuration form.                                                                                                             |
| Dynamic `import()` and `require()`                            | Literal specifiers resolve to file edges. Non-literal specifiers are observations.                                                                              | Unchanged behavior, moved to the shared module-load engine.                                                                                                                                                                        |
| Data direction                                                | `WRITE_KEYWORDS`/`READ_KEYWORDS` in `data-analyzer.ts`, matched as text, shared by JS and Python.                                                               | Replaced by catalog entries that match resolved APIs (Phase 11). **Change** for JS/TS and Python.                                                                                                                                  |

Each **Change** is recorded in `docs/v3/language-parity.md` and must appear in the release notes.

## Phase 2 Status (JS/TS facts layer)

This section records what Phase 2 did to the **Change** rows above. "Not in Phase 2" means the change is deferred to the phase the contract names. It does not mean the change was dropped.

| Concern                                           | Phase 2 status                                                                                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Re-exports (`exports` edges, D9)                  | Not in Phase 2. Still `imports` only. D9 is approved, and the `exports` edge is added in the phase that owns it.                                                                                                               |
| Type-only imports (`metadata.typeOnly`)           | Not in Phase 2.                                                                                                                                                                                                                |
| Enums                                             | Not in Phase 2.                                                                                                                                                                                                                |
| Owners: nested classes and object-literal methods | Not applied. `ownerIdOf` (`src/facts/owner-rule.ts`) implements D6 qualification and is tested, but nothing calls it. Applying it changes JS/TS output, so it needs its own reviewed snapshot change after the owner decision. |
| Decorators                                        | Registry decorators and constructor parameter decorators are facts (`registry-declaration`, `registry-injection`). Python and Rust decorators are not covered.                                                                 |
| Dynamic `import()` and `require()`                | Behavior unchanged. Moved to the module-load engine (`src/facts/module-load-engine.ts`).                                                                                                                                       |
| Data direction                                    | Moved to the data engine (`src/facts/data-engine.ts`). Still keyword-based. Replacement by resolved APIs is Phase 11.                                                                                                          |

### Phase 2 amendments to the fact types

Amendments to the Phase 2.1 fact types in `src/facts/types.ts`:

- `FactTarget` gained a `file` kind (2.7b).
- `ModuleEdge` gained `loadKind` (2.7b). Its `target` is optional: import facts omit it, because no engine reads an import's target. It also has `specifier`, the specifier as written, which the plan's list does not include.
- `Receiver` gained `typeConfidence`, the grade of evidence for `type`, which the plan's list does not include.
- `Declaration`'s kind field is `symbolType`. The field named `kind` is the fact discriminator, which the plan does not describe.
- `ArgValue` replaced the plan's `unknown` variant with `dynamic` and `not-a-name` (2.7a), and gained `callback` with `CallbackResolution` (2.7d).
- `CallSite.callee` is optional, and `CallSite` gained `name` and `text` (2.7a).
- `StatePathFact` was replaced (2.7e).
- New fact kinds: `registry-call`, `registry-declaration` and `registry-injection` (2.7f); `event-call` (2.7g); `data-reference` (2.7h).

### Phase 2 deviations

- The registry engine takes an ordered list of facts plus configured keys, not per-file `FileFacts[]`. Scope discovery depends on every registration in the repository, which per-file input cannot express.
- Manifest and discovered-file registrations have no source span, so they are `RegistryConfiguredKey` records rather than facts.
- The registry front end emits facts for candidates the engine will skip, because a registry's scope depends on them.
- The event front end emits facts for claimed calls, flagged `claimed`, because usage evidence counts them.
- Data edges are written once per file after its first pass, not inline. Graph output is sorted by key, so the output does not depend on insertion order.
- The fact engines import the pure helpers `registryKeyId` and `normalizePath` from `graph.ts`, as `resource-engine.ts` already did. They never use a graph instance.
- D7 fallback B was not used. Each family passed `npm run verify` at its checkpoint.
- Step order: the deviations are recorded in the plan, under "Phase 2 order deviations".

## Analysis Boundaries

These carry over from V2 and now apply to every language.

- Local scope and module resolution take precedence over global-name lookup.
- Matching event names do not connect systems unless their receiver identities are compatible.
- Matching registry keys do not connect systems unless their registry identities are compatible.
- Dynamic values, duplicate candidates, unresolved imports and unsupported constructs become diagnostics or annotations, never guessed edges.
- A method call on a receiver whose type cannot be established emits no edge.
- Type facts are graded by source: checker type (JS/TS only), declared annotation (high), constructor or resolved-return inference (medium). The matrix states where Python and Rust depth differs.
- Every conditional branch is analyzed, and each condition is kept as metadata. Conditions are never evaluated.
- No toolchain is run at generate time: not `tsc`, `python`, `cargo`, `rustc` or a language server.

## Public API Inventory (Phase 0.1)

Current root exports are listed in `docs/v2/phase-0-contract.md`. V3 changes are:

| Export                                                                                                                      | V3 change                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `PythonAnalyzer`                                                                                                            | Retained. Its `analyzeFile` becomes a deprecated compatibility wrapper over the Python front end.                           |
| `RustAnalyzer`                                                                                                              | New. Same wrapper pattern.                                                                                                  |
| `LanguageFrontEnd` (type)                                                                                                   | New. The internal contract for each language. Exported only if needed by tests and not documented as a stable API in 3.0.0. |
| `NodeKind`, `SymbolType`, `RelationshipType`, `Evidence`, `LoadKind`, `StateRootKind`, `UnresolvedReason`, `DiagnosticKind` | Extended. Exhaustive `switch` statements in consumer code must handle the new values.                                       |
| `PackageNode`, `ConnectionMap`                                                                                              | `ConnectionMap` gains `packages`. `PackageNode` is new.                                                                     |
| `ConnectionMapV1`, `ConnectionMapV2` (type)                                                                                 | Retained so older maps can be typed.                                                                                        |

## Runtime Matrix

| Dimension                                  | V3 target                                                                                             |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Node.js                                    | 18, 20, 22                                                                                            |
| OS                                         | Linux (`ubuntu-latest`) and Windows (`windows-latest`). Windows is new in V3.                         |
| Module systems                             | ESM and CJS through the packed tarball.                                                               |
| TypeScript consumers                       | Node16, NodeNext and Bundler resolution.                                                              |
| Languages analyzed                         | JS/TS, Python, Rust.                                                                                  |
| Oracles (CI only, not required at runtime) | TypeScript `resolveModuleName`, CPython `ast` and `importlib.util.find_spec`, `rustc` dep-info files. |

## Corpora and Fixtures (Phase 0.4–0.6)

| Corpus              | File                                                                       | Purpose                                                                                                                               |
| ------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Parity              | `src/testing/parity-corpus.ts`                                             | Language-neutral scenarios, each with a JS/TS, Python and Rust rendition.                                                             |
| Python-specific     | `src/testing/python-corpus.ts`                                             | Python-only forms and negatives.                                                                                                      |
| Rust-specific       | `src/testing/rust-corpus.ts`                                               | Rust-only forms and negatives.                                                                                                        |
| Python baseline     | `test/fixtures/python-baseline/` with `test/snapshots/python-baseline.txt` | Phase 0.8 floor. Every edge in this snapshot must survive Phase 5, or be recorded as a false positive in `docs/v3/python-changes.md`. |
| Existing V2 corpora | `src/testing/*-corpus.ts`                                                  | Unchanged. Continue to gate JS/TS.                                                                                                    |

### Rules for corpus expectations

- Each expectation is written from what the code means, never copied from tool output.
- Expectations use placeholders: `{sym:a.helper}`, `{file:pkg/util.py}`, `{event:ready}`.
- A language may be skipped only where `language-parity.md` says Not applicable, and that row must give a reason.
- A fixture that is expected to fail before its phase is marked `pending: '<phase>'` and listed in `src/testing/parity-corpus.ts`. It is **not** a failing test in `npm test`. Each phase removes its own `pending` markers, so the suite stays green throughout.

### Gating decision (flagged)

The plan said Python and Rust expectations would be failing tests at the end of Phase 0. That would turn `npm test` red for the rest of the project. This contract uses `pending` markers instead, with a CI report that counts how many pending expectations remain per language. The count is the progress measure. It must reach zero for a language before that language's release gate.

## Accuracy and Performance Budgets (Phase 0.7)

Applied to every language and every mechanism family.

| Measure                                                           | Budget                                                                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Expected high-confidence edge recall                              | 100% of declared edges                                                                                                                           |
| Declared false positives                                          | 0                                                                                                                                                |
| Declared observations                                             | 100% produced with the declared reason                                                                                                           |
| Determinism                                                       | Byte-identical JSON and Markdown across repeated runs, on Linux and Windows                                                                      |
| Synthetic repository, 1,000 files, about 150k lines, per language | Scan completes within a runtime budget, recorded in the CI report on the CI runner. The budget is set as 1.5× the first measured run, then held. |
| Repository with `target/`, `.venv` or `node_modules`              | Scan time within 10% of the same repository without those directories                                                                            |

### Python performance baseline

Measured with `BALK2_PERF=1 npx vitest run src/analyzer/python-perf.test.ts` (`src/analyzer/python-perf.test.ts`), which generates 1,000 Python files and times one full `buildConnectionGraphDetailed` run.

| Run                            | Files | Lines   | Time      | Nodes  | Relationships | Budget (1.5×) |
| ------------------------------ | ----- | ------- | --------- | ------ | ------------- | ------------- |
| First run, Windows dev machine | 1,000 | 133,000 | 12,445 ms | 36,000 | 56,000        | 18,670 ms     |

This local run sets the provisional budget. The contract records the budget from the CI runner, so the CI figure replaces this one when it is available. The generated repository has 133,000 lines against the target of about 150,000; the budget applies to the generated size shown here.

## Change Control

- Changes to a Not applicable cell in `language-parity.md` require a reason and a reviewer.
- Each **Change** in the inventory above is recorded in the release notes and in `docs/v3/python-changes.md` or the matching language document.
- The graph schema is versioned. `docs/v3/connection-map-schema.md` is the source of truth for field names.

## Phase 1 Entry Criteria

- This contract is accepted, including D1–D6 and D9.
- `docs/v3/language-parity.md`, `docs/v3/connection-map-schema.md` and the corpora are committed.
- The Python baseline snapshot is committed and passes on Linux and Windows.
- The existing V2 test suite is green on the baseline commit.

## Phase 9.1 output change (Rust symbols)

- The Rust front end (`src/analyzer/rust/front-end.ts`) is registered in step 3 of the build. It writes one symbol per named Rust item, as the Python front end does. This is the first Rust output beyond module files, so every Rust repository's map gains symbol nodes.
- Symbol types: `function`, `method`, `constant`, `variable`, `type`, `struct` (also unions), `enum`, `trait`, `module` (inline `mod x { }`), `macro` (`macro_rules!`). No new `SymbolType` values were needed.
- Names follow the naming table: `Type.method`, `Type[Trait].method`, `module::item`, `name!` for macros. A second name in one scope and namespace gets `#n` by source order. Same-namespace cfg twins share an id.
- Namespaces (`type`, `value`, `macro`) are kept per scope in `src/analyzer/rust/names/namespaces.ts`. A tuple or unit struct occupies both `type` and `value`.
- `exported` is always `false` in 9.1. Exports come in 9.4.
- Not in 9.1: `use` edges (9.3), calls and references (9.6, 9.7), associated consts and types, items inside function bodies or macros (Phase 10).
- Rust syntax problems from the parser are now reported as `syntax` diagnostics.

## Phase 9.3 output change (Rust imports)

- The Rust front end binds each Cargo crate's `use` declarations (`src/analyzer/rust/names/imports.ts`) and writes an `imports` edge from the file of each `use` to the repository file the name lives in, with `evidence: 'ast'` and the `use` span. A glob (`use path::*`) gives an edge to the source module's file with the same rule.
- A `use` that cannot be resolved gets an `unresolved-module-path` node, linked from its file by an `imports` edge at low confidence, as the Phase 8 `mod` declarations are. A glob whose names collide reports `ambiguous-star-import` when a path uses the name.
- Uses that name an extern crate or a standard crate (`std`, `core`, `alloc`, `proc_macro`, `test`) produce no edge and no observation.
- Binding is by rounds until no more names bind, so a `use` may name something another `use` brings in. Explicit uses shadow globs, and items shadow both.
- Edition 2015 resolves `use` paths from the crate root, unless they start with `self`, `super` or `crate`.
- Not in 9.3: `pub use` re-exports for `exports` (9.4), the leading `::` on a `use` path (the parser does not keep it, so it resolves as a uniform path), `use` inside function bodies (Phase 10), and enum variant globs.

## Phase 9.4 output change (Rust exports)

- Lib and proc-macro crates get `exports` edges (`src/analyzer/rust/names/exports.ts`), from the file that declares an item, or from the file of a `pub use`, to the symbol id, with `metadata.visibility: 'public'`. Binary, test, example and bench crates get none.
- An item is exported when a path from the crate root reaches it: through `pub` items, `pub` child modules, `pub use` bindings, and `pub use path::*` globs. A glob's source can be private, so the common `mod inner; pub use inner::*;` layout exports its public items.
- A private module is not walked, even when its items are declared `pub`. `pub(crate)` items are not exported.
- `Declaration.exported` stays false. The export is the `exports` edge.
- Not in 9.4: `#[macro_export]` (Phase 10), enum variants re-exported as associated paths (they are not symbols yet), and checking that a `pub use` names a public item.

## Phase 9.5 output change (Rust impls and supertraits)

- `impl Trait for Type` gives an `implements` edge from the type's symbol to the trait's symbol (`src/analyzer/rust/names/type-relations.ts`). Both are resolved through their paths in the module of the impl, so an impl in another file attaches to the struct it names. Evidence `ast`, with the impl span.
- `trait A: B + C` gives `extends` edges from A to each supertrait that resolves in the repository. Generic supertraits (`Source<u8>`) are read without splitting inside their arguments.
- An inherent impl gives no edge. A blanket impl over its own type parameter (`impl<T> Trait for T`) gives none. A trait or type from outside the repository (`Display` after `use std::fmt::Display`) gives none and no observation.
- A path that looks internal and does not resolve is reported as `unresolved-module-path`, linked from its file by an `implements` or `extends` edge at low confidence.
- Not in 9.5: method owners are still named by the file of the impl (the naming rule of 9.1), and the `implements` edge is the record that links them to the type. `impl Trait for dyn Other` is not read as an impl on `Other` (fixed in 9.9: the self type is checked for `dyn` first). Trait-method dispatch is 9.6.

## Phase 9.6 output change (Rust calls)

- Each call site in a function body that names a function in the repository gives a `calls` edge from the enclosing function's symbol to the callee's symbol (`src/analyzer/rust/names/calls.ts`). One edge per (caller, callee, confidence, dispatch), with one span per call site, and evidence `ast`.
- Path calls resolve as values through scopes and paths. `Type::name()` takes the inherent method at high confidence. Failing that, it takes the single trait impl in the repository that gives `Type` the name, at medium. Two trait impls that both give the name give no edge.
- `Self::name()` and `self.m()` resolve within the enclosing impl. Inside a trait body they resolve to the trait's method.
- A method call resolves when the receiver's type is known from local type rules (2.4). An annotated parameter or `let` is high. A `let` initialized by a resolved function, or by `Type::f()` returning `Self`, is medium. `&`, `&mut`, `Box`, `Rc` and `Arc` are peeled. A name bound more than once loses its type.
- A receiver typed `dyn Trait`, `impl Trait`, or a generic with exactly one trait bound resolves to the trait's method, with `metadata.dispatch: 'trait'`. The trait method is the target, not each implementation.
- A name bound by a `let`, parameter, `for`, closure or match arm is never resolved to an item. A call whose receiver has no known type gives no edge.
- An unresolved module path in a call gets an `unresolved-module-path` node, linked from the calling file by a `calls` edge at low confidence.
- `body.ts` now records the receiver name on `method-call` facts and the initializer and pattern shape on `let` facts. `symbols.ts` and `module-index.ts` record each function with its impl or trait.
- Not in 9.6: calls inside macro arguments, calls inside nested functions (credited to the outer function), tuple-struct constructors, generic inference beyond bounds, and receivers that are fields or call results. References and `extern` declarations are 9.7.

## Phase 9.7 output change (Rust references and foreign functions)

- Enum variants are symbols, `Enum.Variant`, with symbol type `variant` (`src/types.ts` gained the type). A variant's visibility is its enum's.
- A `references` edge goes from a mentioning symbol to the symbol it names (`src/analyzer/rust/names/references.ts`), with evidence `ast`, confidence `high`, and one span per mention. Mentions are: types in function signatures and `let` annotations (owner: the function); struct, union and enum fields (owner: the type; for an enum, the variant); a type alias's type; a const's or static's type and value (owner: the const or static); generic bounds, which name their trait; struct literals; enum variant paths; and tuple-struct constructors, which name the struct.
- Generic parameters are not references. A type named through `Self` is the impl's type. A path that looks internal and does not resolve gets an `unresolved-module-path` observation, linked by a `references` edge at low confidence.
- Functions in `extern` blocks are declared and bind as callable functions, so `calls` edges reach their declarations (9.6 resolved them only when they had a body).
- `#[no_mangle]` functions with an ABI carry `metadata.abi` on their `exports` edge, with the quotes removed. Symbol nodes have no metadata field, so a `#[no_mangle]` item that is not exported (a binary crate, or a private item) has no edge to carry it. That case is open.
- `use ::name` keeps its leading `::` (`UseTree.global`, `UseEntry.global`). Edition 2015 resolves it from the crate root and later editions from the extern crate.
- `impl Trait for dyn Other` gives no `implements` edge. It used to be read as an impl on `Other`.
- Decision beyond the letter of 9.7: `let` annotations count as references, because a type named in a body is a real mention. Remove that clause if the reference model should stay to signatures and fields.
- Not in 9.7: a nested function's mentions are credited to the enclosing function, since nested functions are not symbols; `impl` headers are not mentions; macro arguments are not scanned (Phase 10).

## Phase 9.8 output change (Rust nested items)

- Items written inside a function body (`fn`, `struct`, `enum`, `union`, `trait`, `impl`, `type`, `const`, `static`, `use`) are symbols named under the function: `file:outer::inner`, and for a method, `file:Type.method::inner` (`src/analyzer/rust/nested.ts`, `symbols.ts`).
- Each function with nested items gets a block scope. A name written in the block resolves there first, then in the blocks and module around it. `self`, `super` and `crate` still name the enclosing module, not the block.
- A nested function's calls and references belong to it. The enclosing function gets no edge for a call or mention that lies inside a nested item. The enclosing function does get edges for its own calls to its nested items.
- `use` inside a function body now binds like a module-level `use`. The 9.3 note that deferred it to Phase 10 is superseded.
- `mod` inside a function body is not read. Macro arguments are still not scanned (Phase 10).
- Known limits: const and static initializers with items are handled by the 9.8 addendum below. `extern "C"` blocks inside a body are read by the 9.8 addendum below.

### 9.8 addendum: inner blocks

- Items declared in any `{ }` block inside a function body are read, not only items at the top of the body. Each block that declares items is a scope, keyed by the function id and the block's position (`file:outer::inner` names the item; the scope key is `file:outer{line:column}`).
- A block's items are visible in that block and in the blocks nested inside it. They are not visible outside it.
- Each call and mention resolves in the innermost block scope that holds it. A `let` annotation resolves in its own block too.
- Items inside a block belong to the item, and their calls and references are not credited to the function around the block.

### 9.8 addendum: const and static values, extern blocks

- A `{ }` block inside a const or static value that declares items is a scope, keyed by the const's or static's id. Its items are named under the value (`file:C::helper`), and they follow the same visibility and ownership rules as items in a function body.
- A `const` or `static` value's own mentions and calls resolve in its innermost block scope, the same way a function body's do.
- An `extern` block inside a function body is read, and its functions are declared under the function (`file:outer::puts`). A call from the body resolves to them.
- `extern` items are read only at statement start, so `extern` as part of an expression is not an item.
- Still not read: `mod` items inside a body (by design), and macro arguments (Phase 10). Calls in a const or static value, including calls inside its blocks, resolve to the const or static as their owner. A `let` in a const or static value is tracked the same way as a `let` in a function body: a call or mention of a name it binds never resolves to an item.

### 9 exit: glob visibility and parity markers

- Gap 8 closed. A glob import reaches a child module only when the child has some visibility (`pub`, `pub(crate)`, `pub(super)`, `pub(in ...)`), or when the importer is inside the module the glob names. A private child module is not brought in from outside its parent, as its items are not. `RustModuleNode.reachable` records this.
- The Phase 9 `pending` markers are removed from the parity renditions for imported functions, the typed-receiver method call, the sibling-module negative (`src/testing/parity-corpus.ts`), and the Display/Debug `fmt` symbols (`src/testing/rust-corpus.ts`). They run in `npx vitest run src/analyzer/parity`.
- Still open for Phase 9: `metadata.abi` on non-exported `#[no_mangle]` items (no edge carries it yet, because symbols have no metadata).

### 9.9: exit items 1c and the seed scenarios

- **1c, `#[no_mangle]` items.** A `#[no_mangle]` free function is exported whatever its visibility, because it is a C symbol the linker sees. Its `exports` edge's `metadata.visibility` is the item's declared visibility (`public`, `module` or `private`), and its `abi` is recorded when present. Exports in this crate were `pub` before and are unchanged. Symbol nodes still carry no metadata, so the `abi` lives on the edge only.
- **Seed scenarios added to `src/testing/parity-corpus.ts`:**
  - A. A local binding shadows an imported function, in JS/TS, Python and Rust.
  - B. A method on a receiver of unknown type is not connected (negative).
  - C. A method called on a constructor result is connected. The JS/TS rendition is `pending: '2.5'`, the same as the typed-receiver rendition it mirrors.
  - D. Two globs that supply one name leave the name unconnected (negative).
  - E. A name re-exported through three modules connects to its definition. Python uses the redundant-alias form (`import helper as helper`) so the re-export rule of 4.4 applies.
  - F. A type that implements a trait is linked to it (`implements`), in all three languages.
- Scenario expectations were traced by hand against the code and the existing corpus. They have not run yet, and the run is the check.

### 9.9 JS/TS fixes found by the parity seed scenarios

- **Shadowing (A), fixed.** A JS/TS call whose callee identifier refers to a local binding (a `const` or parameter inside a function) is no longer matched to a module-level name of the same spelling. The check uses the TypeScript checker's declaration. Calls without a checker keep the old name-based behaviour.
- **Import aliases resolve to their definition (E), fixed.** A JS/TS call through an import is drawn to the symbol the checker resolves the import to, following re-exports. Before, it named the file the import came from, which often does not define the symbol, so the edge pointed nowhere in the graph. Such an alias is now drawn to the definition (`c.ts:helper`), not to the re-export file.
- **Ambiguous `export *` names draw no edge (D), fixed.** When a module gets a name from two `export *` declarations and does not declare it itself, no call edge is drawn to either. The check reads one level of re-export, the module the import names. Deeper chains are not checked.
- **Known change.** A default-exported callee is named by its declaration (for example `file:foo`), not by the import name (`file:default`). This only changes edges whose target name was `default`.
- **Snapshot effect.** Edges that moved from a re-export file to the definition, and edges removed for ambiguous names, change the JS/TS snapshot baselines. Each change is a false-positive correction, and the commit message lists them.

### 9 closeout: remaining seed scenarios and pending markers

- Added: a base-class method called through `super` (JS/TS, Python; Rust is not applicable because Rust has no class inheritance), and a call through a `dyn` trait object reaching the trait method (Rust).
- Markers removed, because each rendition now passes: the Rust syntax-error recovery rendition (6.2), and the macro-generated-item negative (10.1). The 10.1 scenario checks only that nothing is invented. The invocation `calls` edge that 10.1 requires is not in it yet, so Phase 10 must add that expectation.
- Markers kept, because the behaviour is missing:
  - `2.5`: JS/TS method calls on typed receivers, constructor results and `super`. A JS/TS method call is matched by name only, so `user.save()` gets no edge to `User.save`.
  - `12.3`: module-level shared state, in all three languages. No `writesState` edges are produced.
  - `11.3`: Rust data lineage. No `generates` or `consumes` edges are produced.
- Phase 8.4 diagnostics are reported. The parity harness now reads `moduleProblems` from the build, so a `"<kind> <path>"` expectation is met by a reported `unreachable-module` or `module-conflict`. Both `8.4` renditions (the unreachable file and the `foo.rs`/`foo/mod.rs` conflict) pass, and their markers are removed.

### 9 closeout (final)

- Added a parity scenario for a call through a generic receiver with one trait bound (`fn show<T: Render>(item: &T)`), which reaches `Render.render`. It passes in the probe.
- `docs/v3/language-parity.md` now records Row 6 for Rust field and call-result receivers as a scope decision, not Deferred. The stale JS/TS and Python notes are corrected: Python inherited calls are recorded (5.3), and the JS/TS typed-receiver gap closes in 2.5.
- Phase 9 exit: the Rust parity scenarios for modules, calls, methods, traits and shadowing pass, along with every Rust negative from 0.6 that belongs to Phases 6–9. The macro negative (10.1) waits for Phase 10.

