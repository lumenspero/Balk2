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
