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

## Phase 10.1 output change (Rust macro invocations)

- A `calls` edge goes from the owner to the `m!` symbol of each `macro_rules!` invocation in the repository, at `high` confidence (`src/analyzer/rust/names/calls.ts`, `macroTarget`).
- The owner is the enclosing function, or the file for a module-level invocation. This matches file-level code in JS/TS and Python, which is owned by the file.
- A bare name `m!` takes the last definition of `m` in the same file that comes before the invocation (textual scope). An invocation written before its definition gets no edge.
- `crate::m!` takes a `#[macro_export]` macro in the crate, from any file. Other paths, and std macros such as `println!`, get no edge.
- A repeated name links to the definition in scope, using the id symbols.ts gave it, so a second definition is `file:m!#2`.
- Tokens inside a `macro_rules!` body are not analyzed, so a call written in a macro body gets no edge. The macro-generated-item negative in `src/testing/rust-corpus.ts` now expects the invocation edge, and it still expects no edge from `run` to the generated item.
- Not in 10.1: macros defined inside a function body (their symbols exist, but invocations do not link to them yet), `#[macro_use]` across files, and macro arguments (10.2).

## Phase 10.2 output change (Rust expression-style macro arguments)

- The arguments of the built-in expression-style macros are scanned like a function body, so calls, method calls and paths in them produce the same edges as elsewhere in the body (`src/analyzer/rust/body.ts`, `EXPRESSION_MACROS`). The list is `format`, the print family (`print`, `println`, `eprint`, `eprintln`), `write`, `writeln`, `panic`, the assert family (`assert`, `assert_eq`, `assert_ne` and the `debug_assert` forms), `vec`, `dbg`, `todo` and `unreachable`. A macro is matched by its last path segment, so `std::println!` counts.
- `matches!` scans only its first argument. The rest is a pattern, and a pattern such as `Some(w)` must not be read as a call.
- Every other macro's tokens are still not scanned. Its syntax is unknown, so a call inside it produces no edge.
- A call inside an expression-style macro now gives `calls` and `references` edges from the enclosing function, with the same confidence as the same call written in the body.
- Not in 10.2: `rust.macros.expressionLike`. The configuration loader has no `rust` section yet, so user-listed macros wait for Phase 15.3. Format-string inline arguments such as `{name}` are not read as paths.

## Phase 10.3 output change (Rust proc macros)

- A `#[proc_macro_derive(Name)]` function in a proc-macro crate provides `#[derive(Name)]`, and a `#[proc_macro_attribute]` function provides `#[name]`. Both are ordinary function symbols. A `#[proc_macro]` function-like macro is recorded as a target only, with no edge in this phase (`src/analyzer/rust/names/proc-macros.ts`).
- A derive on a struct, enum or union, or an attribute on any module-level item or free function, in a crate that depends directly on the proc-macro crate, gives a `references` edge from the item to the providing function. The edge has `high` confidence and `metadata.mechanism` set to `derive` or `attribute`, and one span at the attribute.
- The dependency must be a direct `dependsOn` edge from the consumer's target to the proc-macro target. A proc macro that a consumer reaches only through another crate gets no edge.
- A derive or attribute name provided by two different proc-macro dependencies links to neither, because the name is ambiguous.
- A derive path such as `my_derive::Describe` matches by its last segment. A std derive such as `Debug` matches no provider and gets no edge.
- Not in 10.3: function-like `#[proc_macro]` invocations (`make!(...)`), derives and attributes on items inside a function body, methods, and helper attributes named in `attributes(...)`.

## Phase 10.4 output change (Rust compile-time includes)

- `include!("file")` gives an `imports` edge from the including file to the file it names, with `metadata.loadKind` set to `include-macro` and `high` confidence (`src/analyzer/rust/names/includes.ts`). It is read wherever it appears: at module level, in a function body, or in a const or static value.
- `include_str!` and `include_bytes!` name a file, and the edge's kind depends on what the file is:
  - A template, stylesheet or schema gives a `usesResource` edge from the owning symbol (the function, const or static, or the file for module level), with `metadata.resourceKind` and `metadata.mechanism: "include"`.
  - Any other file that exists gives a `consumes` edge from the owner to an artifact at that path. The artifact's format is the detected data format, or `unknown`, and the edge carries `metadata.embed: true`. A source file included this way also gets an artifact node at its path, next to its file node.
- The path goes through the shared path evaluator (`joinPathParts`, `resolveRepoPath`, 2.2). A plain string is relative to the file that holds the macro. `concat!` may join plain strings and `env!("CARGO_MANIFEST_DIR")`, which resolves to the directory of the owning package's `Cargo.toml`. Adjacent strings are joined, and a leading separator after the package anchor is dropped, so the join is `CARGO_MANIFEST_DIR` plus the rest of the string.
- A path that cannot be evaluated gives a `dynamic-include-path` observation: a variable, a string with an escape, or `env!` of any variable other than `CARGO_MANIFEST_DIR`. A path that names no file in the repository gives an `unresolved-module-path` observation. Each observation is a `low` edge to an unresolved node, with `imports` for `include!` and `consumes` for `include_str!` and `include_bytes!`.
- Not in 10.4:
  - `env!` of `OUT_DIR` and other build outputs (10.5).
  - `file!()`, `module_path!()` and other macros that name a path.
  - `#[path]` on an `include!`.
  - The `rustc` oracle for includes. The `rust-oracle` job compares module files against dep-info, and an include comparison needs an oracle workspace that uses `include_*` and runs `cargo build` in CI. It is not verified in this sandbox, because it has no `cargo`.

## Phase 10.5 output change (Rust build scripts)

- A build script (`build.rs`) prints `cargo:rerun-if-changed=PATH`, or `cargo::rerun-if-changed=PATH`, through `println!` or `print!`. Each such line gives a `reads` edge from the function that prints it to the file it names, with `metadata.mechanism: "build-script"` and `high` confidence (`src/analyzer/rust/names/build-scripts.ts`). A file that is not a data format is an artifact of format `unknown`.
- Cargo runs a build script from the package directory, so the path is relative to the package, and it resolves through the package anchor. A path with a format placeholder such as `{}` gives a `dynamic-include-path` observation. A path that names no repository file gives an `unresolved-module-path` observation. Each is a `low` edge to an unresolved node, attempted as `reads`.
- An `include!`, `include_str!` or `include_bytes!` of `env!("OUT_DIR")` no longer gives the 10.4 dynamic observation when its package has a build script. It gives a `dependsOn` edge from the package target that includes the file to the package's `build-script` target, with `metadata.kind: "build-output"` and `medium` confidence, as the plan requires. A package with no build script keeps a `dynamic-include-path` observation, attempted as `imports`.
- The build script of a package is the `build-script` target with the same manifest. A package has at most one.
- Not in 10.5: other build-script output directives (`cargo:rustc-cfg`, `cargo:rustc-env`, `cargo:rustc-link-lib`) and `cargo:rerun-if-env-changed`, which read no file. Environment variables set by Cargo other than `OUT_DIR` and `CARGO_MANIFEST_DIR` remain dynamic.

## Phase 11.1 output change (JS/TS data lineage catalog)

- A `fs` or `fs/promises` call (`readFile`, `readFileSync`, `createReadStream`, `writeFile`, `writeFileSync`, `appendFile`, `appendFileSync`, `createWriteStream`) whose callee is bound by an import from that module now sets the direction of the data artifact it is given, at `high` confidence. The catalog is in `src/facts/data-catalog.ts`. Resolution is in `src/analyzer/data-api.ts` and uses the TypeScript checker, so it applies in repository analysis only.
- The direction comes from the catalog, not from keywords. Two kinds of edge change in JS/TS repositories: `appendFile`/`appendFileSync` now give `generates` where the keyword rule gave a low-confidence `reads`, and a read whose path contains `write` (for example `readFile('write-cache.json')`) gives `consumes` where it gave `generates`. Neither case is in the existing snapshots.
- An unresolved call, a local object with the same method name, a single-file `analyzeFile` run, and every other API keep the keyword rule, so their output is unchanged.
- Not in 11.1: DuckDB, Parquet and Arrow readers, `fetch` of local paths, `require('fs')`, and `copyFile`/`rename`, which have one artifact per direction. They stay on the keyword rule until their catalog entries land.

## Phase 11.4 output change (bare relative data paths)

- A bare relative data path in a JavaScript or TypeScript file is now placed by the shared rule in `resolveBarePath` (`src/facts/path-value.ts`). It is checked in the file's directory first, then at the repository root. A single existing candidate is used. When both exist, the file's directory is used. When neither exists, the path is taken at the repository root, as before.
- The output changes only where the file's directory holds the data file. For example, `src/app/load.ts` reading `'data.json'` gives `src/app/data.json` when that file exists and the root file does not. The same call gives `data.json` when only the root file exists, or when neither file exists.
- The placement uses the set of every scanned path (`dataPaths`, set by the JS/TS front end). A caller that does not pass the set keeps the path as written, as single-file analysis does.
- `data.pathBase` (Phase 15.3) overrides the default order for every language. The order is a parameter of `defaultBareBases` now, and the config key is not read yet.
- Not in 11.4: Python and Rust use the same rule through the Python and Rust front ends (11.2 and 11.3). Rust bases use the package directory first, then the root.

## Phase 11.5 output change (const bindings in JS/TS)

- A `const` whose initializer is a string literal is a path value. When it is passed as an argument to a catalog call (11.1), the call gives a data edge at high confidence, with the direction the catalog gives. This works for a constant in the same file and for one imported from another repository file (`src/facts/data-catalog.ts`, `flowedDataUse` in `src/analyzer/data-api.ts`).
- The edge starts in the file that makes the call. The bare path is placed from the file that declares the constant, through the rule in 11.4.
- A `let` or `var` whose initializer is a string literal flows only when nothing in its enclosing function assigns it again (plain assignment, destructuring assignment, `++`/`--`, `+=`-style compound assignment, a `for…in`/`for…of` target, or a second `var` declaration). The check is conservative: a reassignment anywhere in the function stops the flow. A constant passed to a call outside the catalog gives no catalog edge. Its direction would be a guess.
- The declaration itself keeps the keyword edge it already had.
- Not in 11.5: a path built by concatenating constants.

## Phase 11.2 change to the JS/TS catalog (argument position)

- A JS/TS catalog call now matches only when the artifact is its first argument. Before, a string literal in any argument position matched, so `fs.writeFileSync(out, 'x.json')` treated the content as the target. The fix is in `src/analyzer/data-api.ts` (`dataApiOfLiteral`, `flowedDataUse`) and the catalog's `argument` field.

## Phase 11.3 output change (Rust data lineage)

- Rust had no data lineage before this phase. A call whose full path resolves to a catalog API (`RUST_DATA_APIS` in `src/facts/data-catalog.ts`), with a plain string literal in the artifact's argument position, now gives a `high` data edge. The pass is `src/analyzer/rust/data-apis.ts`, which reads the token trees and resolves the first segment through the file's top-level `use` items.
- Covered: `std::fs` `read`, `read_to_string`, `write`, `copy` (source read, destination written); `std::fs::File` `open` and `create`; `csv::Reader::from_path` and `csv::Writer::from_path`; `rusqlite::Connection::open` (`reads`); `polars::prelude` `scan_csv` and `scan_parquet`, and `CsvReader::from_path`.
- A `Path::new("x")` or `PathBuf::from("x")` argument, and `&"x"`, are read as the string. A raw string or an escaped string is not.
- A method call on a value (`h.open(...)`) and a bare name with no `use` are not matched. An argument that holds contents rather than a path (the second argument of `fs::write`) is not matched.
- A bare path is placed from the package directory (the nearest `Cargo.toml`), then the repository root (11.4).
- The write-then-read parity scenario (`src/testing/parity-corpus.ts`) now passes in Rust. Its `pending: '11.3'` marker is removed.
- Builder chains are matched when they end in `from_path`: `csv::ReaderBuilder::new()…from_path(p)` consumes its path and `csv::WriterBuilder::new()…from_path(p)` generates it. `OpenOptions` and `File::options()` chains end in `open`. A `from_path` on a builder not made by `new()` is not matched.
- Polars readers and writers that take a path directly are matched: `LazyCsvReader::new(p)` consumes, and `LazyFrame::scan_csv`/`scan_parquet` consume. The Polars readers and writers that take a `File` (`ParquetReader::new`, `CsvWriter::new`, and `serde_json::from_reader`) are matched at the `File::open` or `File::create` call that makes the handle, not at the reader or writer.
- Not in 11.3: glob imports (`use polars::prelude::*`), `pub use` re-exports, and `LazyFrame` sink methods (`sink_parquet(p)` and similar), which need the receiver's type.


## Phase 11.6 output change (gaps closed in the language passes)

- **JavaScript and TypeScript, `fetch`.** The global `fetch` is a catalog read of its path (module `global`, consumes its first argument), when the call resolves to the library's own declaration. A program's own function named `fetch` is not matched. A served path is placed from the package's `public/` folder, then the package root, then the repository root. It is a high-confidence edge only when one of those candidates is a scanned file. Otherwise the edge is the low keyword edge, placed at the root, as an unresolved path has always been. The keyword rule now reads `fetch` at low confidence, so a `fetch` line is no longer a high edge by keyword alone.
- **JavaScript and TypeScript.** `const fs = require('fs')` and `const { readFileSync } = require('fs')` bind their module as an import does. `copyFile`, `copyFileSync`, `rename` and `renameSync` read their first argument and write their second, on `fs` and `fs/promises`.
- **Python.** The line-based keyword pass places bare literals by the 11.4 rule (see `python-changes.md`). `pathlib.Path` and pandas DataFrame receivers are typed from a single assignment (see `python-changes.md`).
- **Rust.** `const` and `static` items with a plain string value are followed when a catalog call names them, including through `use crate::…` to a constant in another file. The fact then carries the declaring file, and the path is placed from there. `static mut` is not followed. `use` items are scoped to their block (an inline `mod` or a function body), so a `use` inside one block does not apply outside it. `OpenOptions::new()` and `File::options()` chains take their direction from `write(true)`, `append(true)`, `create(true)`, `create_new(true)` and `truncate(true)`: any of these makes the chain a write, and only `read` leaves it a read. A chain on any other value is not matched.

## Phase 11 exit criterion

A repository with a Python writer of JSON, a Rust converter from that JSON to Parquet, and a TypeScript reader of the Parquet gives four high-confidence edges that meet at the same two artifact paths. `src/analyzer/data-lineage-pipeline.test.ts` checks this through the whole pipeline.

## Phase 11.6 output change (DuckDB SQL)

A string or template with no substitutions, passed as the first argument of `all`, `run`, `exec`, `each` or `prepare` on a DuckDB handle, is read as SQL. A handle is a `const` bound to `new duckdb.Database(…)`, or to `connect()` on one; a reassigned name is not a handle. A file named by `read_csv`, `read_parquet`, `read_json` (and their `_auto` and `_scan` aliases) is a read. A `COPY … TO 'path'` target is a write. Each is a high-confidence edge from the calling file. The edge's span is the whole SQL string, since the path sits inside it. SQL held in a variable is not followed.

## Phase 11.6 output change (Rust module paths)

A `use` of a constant is followed through the crate's module tree. `crate::`, `self::` and `super::` are resolved from the module the `use` is written in, and an inline `mod` is a module of its own. An inline module starts with no `use` or constant names of its parent, as Rust requires, so a parent's `use` is not visible inside it. A file module's parent is the module that declares it. A constant is placed from the file that declares it.

## Phase 11.4 output change (`data.pathBase`)

`data.pathBase` in `.balk2.json` sets the order a bare relative data path is placed in. A list gives the order for every language, and an object gives it per language (`javascript`, `python`, `rust`); a language it does not name keeps the default. Bases are `file`, `package`, `repository` and `public`. The repository root always comes last, whatever the list says. Unknown bases and languages are reported and ignored. A served URL path, such as `fetch`, keeps its own order, since it is a URL rather than a file path.

## Phase 11.5 output change (let bindings in Python, JS/TS and Rust)

- Python: a name bound exactly once inside a function, to a plain string literal, is a path value at catalog calls in that function. A name bound more than once in the function holds no single path, and it does not fall back to a module constant of the same name. A parameter or any other binding also shadows a module constant.
- JS/TS: see the `let`/`var` rule above.
- Rust: a non-`mut` `let NAME = "literal";` is a constant for the rest of its block, when the block binds NAME once. A `mut` binding, a second binding of the same name in the block, or a non-literal binding is not a constant, and it hides an outer constant of the same name. The scope is the block that holds the `let`. A `let` that appears after a use in the same block is still counted for that use (the rule is block-wide, not sequential), which is a known limit.
- In all three, the edge starts in the file that makes the call and the path is placed under the 11.4 rule from that file.

## Phase 11.1 output change (JS/TS catalog)

- `parquetjs` and `@dsnp/parquetjs`: `ParquetReader.openFile(p)` consumes its path (argument 0), and `ParquetWriter.openFile(schema, p)` generates it (argument 1). They match through a named import (`ParquetReader.openFile`) or a namespace import (`pq.ParquetReader.openFile`). A class the program declares with the same name does not match.
- The JS resolver accepts a `Name.method` callee on a named or namespace import. Only dotted catalog names can match it, so no existing call changes.
- Arrow: the JS library has no path-taking reader. Arrow IPC bytes are read through `fs` (`tableFromIPC(fs.readFileSync(p))`), which the `fs` catalog already matches.
- hyparquet takes a buffer or an async buffer from a helper, not a path, so it is not in the catalog. Its files are not matched unless an `fs` read supplies them.
- DuckDB SQL (`read_parquet`) is matched by the DuckDB handle path in 11.6.
- Known keyword limit, unchanged: a call the catalog does not match still falls to the keyword rule, and a keyword in the call's text, such as `read` inside `ParquetReader`, gives a high edge. Changing that would alter existing snapshots, so it is left for a separate decision.

## Phase 11.2 output change (Python anchors)

- A path built from the script's own location (`__file__`, `os.path.dirname`, `os.path.abspath`, `Path(...).resolve().parent`, `os.path.join`, pathlib `/`) is anchored to the directory of the file that holds it, and is placed exactly, not as a bare relative path. An anchored path above the repository root keeps its `../` parts.
- The catalog call that takes an anchored path claims its literal's last segment, so the keyword pass does not add a second edge.
- Handle loads (`json`, `pickle`, `csv`, `yaml`, `tomllib`) have no catalog entries: their path is the `open` call that made the handle.
- `self.<attr>` directory joins are carried over from 2.0.0 unchanged.
