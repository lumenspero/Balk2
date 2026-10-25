# Language parity matrix

This matrix holds JavaScript/TypeScript, Python and Rust to the same standard. Each row is a mechanism family. Each cell is one of:

- **Supported**: the mechanism is recognized for the forms its language doc lists.
- **Partial**: recognized for some forms. The language doc lists what is missing.
- **None**: not recognized yet. Each None cell has a target phase.
- **N/A**: the mechanism does not exist in the language. The reason is given and is based on language semantics, never on analyzer weakness.

"Now" is the current 2.0.x state. "V3" is the target at the 3.0.0 release gate. Phase numbers refer to `balk2-v3-implementation-plan.md` (repository root).

## Matrix

| #   | Mechanism family                                 | JS/TS now                                        | JS/TS V3                                                               | Python now                                                                                                   | Python V3                                                           | Rust V3                                                                                         | Phase          |
| --- | ------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------- |
| 1   | Module imports (file edges)                      | Supported                                        | Supported                                                              | Supported                                                                                                    | Supported                                                           | Supported                                                                                       | 4, 8, 9        |
| 2   | Re-exports and barrels                           | Partial (file edge only)                         | Supported (D9)                                                         | None                                                                                                         | Supported                                                           | Supported                                                                                       | 0.3, 4.4, 9.4  |
| 3   | Exports                                          | Supported                                        | Supported                                                              | Partial (no `__all__`)                                                                                       | Supported                                                           | Supported (lib only)                                                                            | 4.4, 9.4       |
| 4   | Symbols and owners                               | Supported                                        | Supported (nested classes added)                                       | Supported                                                                                                    | Supported                                                           | Supported                                                                                       | 2.6, 5.2, 9.1  |
| 5   | Calls (direct)                                   | Supported                                        | Supported                                                              | Partial (same file and imports, single line)                                                                 | Supported                                                           | Supported                                                                                       | 5.4, 9.6       |
| 6   | Method calls through typed receivers             | Supported (checker types)                        | Supported (checker types)                                              | None                                                                                                         | Supported (annotation, constructor)                                 | Supported (annotation, constructor)                                                             | 2.4, 2.5       |
| 7   | Construction (`new X()` / `X()`)                 | Supported                                        | Supported                                                              | Partial                                                                                                      | Supported                                                           | Supported                                                                                       | 5.4, 9.6       |
| 8   | Inheritance and implementation                   | Supported                                        | Supported                                                              | Supported (base classes and inherited calls)                                                                 | Supported (C3 MRO)                                                  | Supported (`impl`, `trait:`)                                                                    | 5.3, 9.5       |
| 9   | Type references                                  | Supported                                        | Supported                                                              | None                                                                                                         | Supported                                                           | Supported                                                                                       | 5.6, 9.7       |
| 10  | Decorators and attributes                        | Supported (registration and parameter injection) | Supported                                                              | None                                                                                                         | Supported                                                           | Supported (attributes, derives)                                                                 | 5.5, 7.3, 12.2 |
| 11  | Global symbols (global object)                   | Supported                                        | Supported                                                              | N/A for global object; `builtins` assignments Supported                                                      | Supported (`builtins` root)                                         | N/A: no implicit global object                                                                  | 12.3           |
| 12  | Module-level state (D8)                          | None                                             | Supported (`global`, `module.NAME`, `builtins`, configured singletons) | Supported (`static`, `static mut`, interior statics, `lazy_static!`, `thread_local!`, configured singletons) | Supported                                                           | Supported (`static`, `static mut`)                                                              | 2.3, 12.3      |
| 13  | Events                                           | Supported                                        | Supported                                                              | None                                                                                                         | Supported (`pyee`, `blinker`, Django signals, `threading.Event`)    | N/A for name-keyed channels; configured method protocols on types with subscribe and emit impls | 12.1           |
| 14  | Registries                                       | Supported                                        | Supported                                                              | None                                                                                                         | Supported (dict literal, `register(...)`, decorators, entry points) | Supported (literal-keyed static maps)                                                           | 12.2           |
| 15  | Callbacks                                        | Supported                                        | Supported                                                              | None                                                                                                         | Supported                                                           | Supported (function paths passed to resolved functions)                                         | 12.4           |
| 16  | Dynamic module loads                             | Supported (`import()`, `require`)                | Supported                                                              | Partial (literal `importlib.import_module`)                                                                  | Supported (`__import__`, `spec_from_file_location`, `runpy`)        | Partial (`libloading` literal paths, observation only)                                          | 12.5           |
| 17  | Resources (templates, styles, schemas, includes) | Supported                                        | Supported                                                              | None                                                                                                         | Supported (`importlib.resources`, `pkgutil`, template loaders)      | Supported (`include_*!`)                                                                        | 10.4, 12.6     |
| 18  | Runtime metadata (`Reflect`)                     | Supported                                        | Supported                                                              | N/A: no string-keyed runtime metadata API; decorators are covered by row 10                                  | N/A (same reason)                                                   | N/A: no string-keyed runtime metadata API; attributes are covered by row 10                     | 12.8           |
| 19  | Data lineage (read, write, generate, consume)    | Supported (keyword-based)                        | Supported (catalog-based, resolved APIs)                               | Supported (keyword-based)                                                                                    | Supported (catalog-based)                                           | Supported (catalog-based)                                                                       | 11             |
| 20  | Process execution (`executes`)                   | None                                             | Supported                                                              | None                                                                                                         | Supported                                                           | Supported                                                                                       | 14.5           |
| 21  | Package manifests and workspaces                 | None                                             | Supported (`package.json`)                                             | None                                                                                                         | Supported (`pyproject.toml`, `setup.cfg`)                           | Supported (`Cargo.toml`)                                                                        | 4.1, 7.5       |
| 22  | Cross-language boundaries                        | None                                             | Supported (consumer side)                                              | None                                                                                                         | Supported (consumer and producer)                                   | Supported (producer side)                                                                       | 14.2–14.4      |
| 23  | Source annotations                               | Supported                                        | Supported (shared grammar)                                             | Supported                                                                                                    | Supported (shared grammar)                                          | Supported                                                                                       | 12.7, 10.3     |
| 24  | Syntax diagnostics                               | Supported                                        | Supported                                                              | None                                                                                                         | Supported                                                           | Supported                                                                                       | 3.3, 6.2       |
| 25  | Test code tagging (D5)                           | None                                             | Supported                                                              | None                                                                                                         | Supported                                                           | Supported                                                                                       | 5.2, 7.2       |
| 26  | Conditional branches (metadata only)             | Partial                                          | Supported                                                              | None                                                                                                         | Supported (`TYPE_CHECKING`, `try/except ImportError`)               | Supported (`cfg`)                                                                               | 4.3, 8.3       |
| 27  | Type-only imports (`typeOnly`)                   | None                                             | Supported                                                              | None                                                                                                         | Supported                                                           | Supported (type-only uses)                                                                      | 0.3, 4.3       |

## Not applicable cells, with reasons

- **Row 11, Rust.** Rust has no implicit global object. Its equivalent shared state is `static`, which is covered by row 12.
- **Row 11, Python.** Python has no global object. The `builtins` module is the nearest equivalent. Assignments to `builtins.x` are the global root, covered by row 11 and row 12.
- **Row 11, JS/TS (traversal).** Named access to the global object, such as `window.x` or `globalThis.x`, is recorded under rows 11 and 12. Enumerating the global object, such as `Object.keys(globalThis)` or `for (const k in window)`, names no fixed symbol, so it is not recorded.
- **Row 18, Python and Rust.** Neither language has a runtime metadata API that reads string-keyed values from declarations. Python decorators and Rust attributes, which are the usual carriers of this information, are covered by row 10.
- **Row 6, Rust (field and call-result receivers).** A receiver that is a field (`self.store.save()`) or a call result (`make().save()`) has no type. V3 gives receivers types only from annotated bindings and constructor results (2.4), and inference through fields and call results is outside the V3 scope. This is a scope decision, recorded so the cell is not Deferred. The same limit applies to Python.
- **Row 13, Rust.** Name-keyed event channels do not exist in Rust. Channels connect by passing values. Configured method protocols still apply to types that declare both a subscribe and an emit method, using the same `event-like` rule as JS/TS.

## Partial cells, and what closes them

- **Row 2, JS/TS.** Barrels record only a file-level `imports` edge. D9 adds `exports` for the re-exported names.
- **Row 5, Python.** Calls on one line only, and only to names in the same file or directly imported. Phase 3 (multi-line tokenizer) and Phase 5 (scoped resolution) close it.
- **Row 6, JS/TS.** Calls such as `user.save()` where `user` is bound to `new User()`, and `super.save()`, are recorded from the checker's receiver type. Only methods of repository classes count.
- **Row 6, Rust.** Only annotated bindings and constructor results give a receiver type. Inference through generics, auto-deref and chained method results is out of scope for V3. The same limit applies to Python.
- **Row 8, Python.** Base classes and inherited method calls, including `super()` and `self.` calls through the method resolution order, are recorded (Phase 5.3).
- **Row 16, Rust.** `libloading` paths are observation-only. A literal path is not a source-level dependency in the way an import is.
- **Row 26, JS/TS.** Conditions are not recorded as metadata today.

## Differences in shared representation

These cells change behavior for JS/TS. Each is listed in the release notes.

| Change                                              | Affected rows | Notes                                                                                                                                              |
| --------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Named re-exports produce `exports` edges (D9)       | 2, 3          | Additive. Barrels gain edges.                                                                                                                      |
| `import type` gets `typeOnly: true`                 | 27            | Metadata added to existing `imports` edges.                                                                                                        |
| Enums become `enum` symbols                         | 4             | New symbols. Previously absent from the map.                                                                                                       |
| Nested classes become `Outer.Inner` symbols         | 4             | New symbols. Methods of nested classes gain owners.                                                                                                |
| Module-level state (D8)                             | 12            | New `statePaths` and `state` edges.                                                                                                                |
| Data direction moves from keywords to resolved APIs | 19            | Some edges change confidence or direction. Covered by the zero-diff rule in D7 only where snapshots allow it; any change is reviewed and recorded. |

## Rules

- A row can be marked N/A only with a reason based on language semantics.
- A cell can move from None or Partial to Supported only when its corpus scenarios pass in `src/testing/parity-corpus.ts`, or in the language corpus for language-specific rows.
- A cell cannot move to N/A to avoid work. Moving a cell to N/A is a change to this document and needs a reviewer.
- A Partial cell in the V3 column at release time must have a documented limit in its language document, and an explicit approval in the release notes.

## Verification

- `npx vitest run src/analyzer/parity` runs every parity scenario that has passed its phase.
- The `pending` count per language is reported in CI. The count must be zero for each language before that language's release gate.

## Shared state: recorded limits (Phase 12.3)

Shared state records what a function writes, and what it does to an interior-mutable static. These
limits are known and recorded, not defects in the matrix cells above.

- **Python.** A module global is read only when a function writes it through `global`. A read of a
  global that nothing writes is not recorded. Writes made by module-level code are not read.
  Writes to a subscript such as `d[k] = v` are not recorded. A local that shadows an import inside a
  function is not checked. Reads of a configured singleton's fields are not recorded.
- **Rust.** Writes through a field are read only for a configured singleton. Writes through an index
  and tuple-index fields such as `.0` are not read. Plain reads of a static, such as a `println!`
  argument, are not recorded. A `lock()` acquisition is recorded as a read; the `access: "lock"`
  annotation from the plan is not emitted, because state facts carry no access field. Writes made
  inside a `thread_local!` `with` closure are not read. A configured singleton that matches no
  static is ignored without a diagnostic, unlike JS/TS. The state pass builds the repository model a
  second time, which adds time on large crates.
- **JS/TS.** Module `let` bindings reassigned in a function and configured singletons are recorded,
  including reads of a singleton's fields. This is the reference the other languages follow.

## Phase 12 exit status

Phase 12 exit criteria are met. The parity suite has 95 tests, and every rendition runs and passes in each language it covers. The negative counterparts are in the corpus: the same key in two registries does not connect, the same event name on two emitters does not connect, and a local binding of a shared name is not shared state. The three JS renditions that were pending on Phase 2.5 now pass, so rows 6 and 8 stay Supported for JS/TS.

## Phase 13 exit status

Phase 13 exit is conditionally met. Two parts of the budget check still need a run outside this environment, listed below.

**Parity matrix.** No cell is Deferred. The deferred items in `docs/v3/deferred.md` were approved by the user on 2026-10-25, and the Not applicable rows are recorded above with their reasons. Partial cells remain, as listed in "Partial cells, and what closes them".

**Accuracy suites.** `npm run test:accuracy` runs 7 files and 227 tests, and all pass. Recall and declared false positives meet the budget for each family and language covered.

**Performance.** Each language has a synthetic 1,000-file baseline in the repository, enabled with `BALK2_PERF=1`. The contract sets each budget at 1.5 times the first measured run on the CI runner. These runs were on the development sandbox (Linux), not the CI runner, so they are provisional until the CI figures replace them.

| Language | Test                                                                | Files |   Lines |   Time |  Nodes | Relationships |
| -------- | ------------------------------------------------------------------- | ----: | ------: | -----: | -----: | ------------: |
| Python   | `src/analyzer/python-perf.test.ts` (first run, Windows dev machine) | 1,000 | 133,000 | 12.4 s | 36,000 |        56,000 |
| JS/TS    | `src/analyzer/js-perf.test.ts`                                      | 1,000 | 127,000 | 18.7 s | 36,002 |        65,001 |
| Rust     | `src/analyzer/rust/rust-perf.test.ts`                               | 1,000 | 172,000 |  5.8 s | 36,002 |        60,001 |

**Determinism.** Repeated builds of `expressjs/express`, `BurntSushi/ripgrep` and `dtolnay/async-trait` serialize to byte-identical JSON on Linux. Windows has not been run for this check.

**Overhead of excluded directories.** `expressjs/express` was scanned three times as a clean copy and three times with a 3,000-file `node_modules`, a 2,000-file `target/` beside a `Cargo.toml`, and a 2,000-file `.venv` marked by `pyvenv.cfg`. Median clean scan 4.6 s, median with the directories 5.0 s, about 9% more. This is within the 10% budget, but the runs were noisy (the first clean run took 6.5 s), so the margin is thin.

**Still open for Phase 13 exit:**

- The CI runner budget for each language, which replaces the provisional figures above. The `perf` workflow (`.github/workflows/perf.yml`) runs the three perf tests with `BALK2_PERF=1` on `ubuntu-latest` and `windows-latest` and uploads the timings as an artifact. It is not a required check. `test/perf-budgets.json` is empty until the first runs are recorded; each entry is 1.5 times that platform's first measured time, and `assertWithinBudget` then fails any test that exceeds its budget.
- Determinism on Windows.

Phase 13 is complete when those two items are measured. Everything else in the exit criterion is met.
