# Session Delta: Phase 9 Complete

**Range:** `50d2412` (Phase 8 close-out) to `1d594af` (Phase 9 closeout, generic receiver parity, capability matrix). The follow-up `ad36f6b` (8.4 diagnostics in the parity harness) is included because it closes the 8.4 markers that Phase 9's corpus depends on.
**Status:** Phase 9 is complete. Items 9.1 through 9.8 are implemented. Item 9.9 adds the seed parity scenarios and the 1c `#[no_mangle]` export rule. The exit criterion is met: the Rust parity scenarios for modules, calls, methods, traits and shadowing pass, and so does every Rust negative from 0.6 that belongs to Phases 6 to 9. The macro negative (10.1) moves to Phase 10.
**Verification:** the user ran the suite after each commit and reported it green. This agent could not run vitest in the sandbox, so the test results here are user-reported.

## Commits

| Commit    | Subject                                                          | Files | Lines (+/-) | Notes                                                                     |
| --------- | ---------------------------------------------------------------- | ----- | ----------- | ------------------------------------------------------------------------- |
| `69d8b85` | 9.1 complete                                                     | 7     | +637 / -5   | Namespaces, symbol naming, `variant` symbols.                             |
| `40cf4a4` | 9.2 complete                                                     | 4     | +541 / -1   | Path resolution: `crate::`, `self::`, `super::`, `::name`, extern crates. |
| `6fcfe29` | 9.3 complete                                                     | 7     | +897 / -110 | `use` trees and globs. `use ::x` keeps its leading `::`.                  |
| `154cf4b` | 9.4 complete                                                     | 5     | +194 / -5   | Exports, computed as a fixed point from the crate root.                   |
| `b839fa6` | 9.5 complete                                                     | 6     | +390 / -1   | `implements` and `extends` for impls and traits.                          |
| `a65ec5b` | 9.6 complete                                                     | 8     | +905 / -8   | Calls: paths, inherent and trait methods, typed receivers, dispatch.      |
| `6a7e4ae` | 9.7 and 9.8                                                      | 17    | +951 / -44  | References, `extern` functions, `#[no_mangle]` ABI, nested items.         |
| `289f6fa` | 9.8 inner block change                                           | 7     | +210 / -82  | Items in any `{ }` block of a function body.                              |
| `04051ae` | 9.8 const and static values, extern blocks                       | 6     | +177 / -49  | Items in const and static values. `extern` blocks inside bodies.          |
| `37fea2c` | 9.8 new tests and bindcalls                                      | 3     | +53 / -17   | Calls inside const and static values.                                     |
| `9d65e8f` | 9.8 let bindings                                                 | 4     | +18 / -5    | `let` in const and static values shadow items.                            |
| `3975fc1` | 9.8 glob visibility                                              | 6     | +36 / -5    | Gap 8. Labelled 9.8 but it is 9.9 scope (see Decisions).                  |
| `e5a4d36` | 9.9 seed scenarios, #[no_mangle] exports, JS/TS call fixes       | 7     | +420 / -10  | Seed scenarios A to F. JS/TS shadowing, alias and ambiguity fixes.        |
| `c4076c4` | Phase 9 closeout: super and dyn parity scenarios, pending review | 3     | +68 / -3    | `super` and `dyn` scenarios. Pending markers reviewed.                    |
| `ad36f6b` | V3 Phase 8.4: report module diagnostics in the parity harness    | 3     | +9 / -9     | Harness reads module diagnostics. Removes the 8.4 markers.                |
| `1d594af` | V3 Phase 9 closeout: generic receiver parity, capability matrix  | 3     | +28 / -3    | Generic receiver scenario. Matrix notes corrected.                        |

Total: 16 commits, 34 files, +5,223 / -46 lines.

## What Phase 9 built

- **Names** (`src/analyzer/rust/names/`): module index with block scopes (`module-index.ts`), path resolution (`resolve.ts`), `use` trees and globs (`imports.ts`, `use-tree.ts`), exports (`exports.ts`), and the namespace tables (`namespaces.ts`).
- **Symbols** (`src/analyzer/rust/symbols.ts`): `Type.method`, `Type[Trait].method`, `module::item`, `Enum.Variant`, `outer::inner` for nested items, and `file:C::helper` for items in const values.
- **Type relations** (`type-relations.ts`): `implements` and `extends`, with `impl Trait for dyn Other` skipped.
- **Calls** (`calls.ts`): path calls, inherent methods first, then a unique trait impl at medium confidence. `Self::` and `self.m()` resolve within the impl. Typed receivers come from annotations (high) or constructors and function results (medium), with `&`, `Box`, `Rc` and `Arc` peeled. `dyn` and single-bound generic receivers dispatch to the trait method. Locals never resolve to items.
- **References** (`references.ts`): mentions in signatures, fields, variants, bounds, struct literals and variant paths, resolved in their block scope.
- **Nested items** (`nested.ts`): items in any `{ }` block of a body or const value, with their own calls and references.
- **Front end** (`front-end.ts`): exports carry visibility and `abi`, and the calls and references are wired as edges.
- **Parity** (`src/testing/parity-corpus.ts`, `rust-corpus.ts`, `src/analyzer/parity.test.ts`): seed scenarios A to F, and Rust scenarios for `super`, `dyn`, generic receivers and `implements`. The harness now checks diagnostics.
- **Docs**: `docs/v3/phase-0-contract.md` (sections 9.1 to 9.9), `docs/v3/language-parity.md` (matrix notes).

## Decisions

1. **`#[no_mangle]` free functions are exported whatever their visibility** (1c). The exports edge records the declared visibility. The `abi` lives on that edge only, because symbols have no metadata. Symbol-level metadata waits for the schema work.
2. **Glob imports reach a child module only when the child has some visibility**, or when the importer is inside the module the glob names. This is gap 8.
3. **JS/TS calls go through the checker.** A callee that refers to a local declaration draws no edge. An import is followed through re-exports to its definition. A name supplied by two `export *` declarations, and not declared by the module, draws no edge. The ambiguity check reads one level of re-export.
4. **Pending markers stay only where the behaviour is missing.** Each marker was checked by probe before it was removed or kept.
5. **Scenario tests are written as language-neutral expectations.** Renditions that the code does not yet satisfy are marked `pending` with the phase that owns them.
6. **Label note.** `3975fc1` is labelled "9.8 glob visibility" but it is the gap 8 fix, which belongs to 9.9. The label is left as committed. Like Phase 7's label collision, this note keeps the history readable.

## Bugs found and fixed in this phase

- **Enum variants were not symbols.** Fixed in 9.1 with `variant` symbols.
- **`use ::x` lost its leading `::`.** Fixed in 9.3 with the `global` flag.
- **Private child modules leaked through globs.** Gap 8, fixed in `3975fc1`.
- **`impl Trait for dyn Other` produced an edge to `Other`.** Fixed in 9.5.
- **JS/TS shadowing false positive.** A local `const` with the name of an imported function still drew a call edge. Fixed in `e5a4d36`.
- **JS/TS re-export edges pointed at the re-export file.** The edge named a file that did not define the symbol. Fixed in `e5a4d36`.
- **JS/TS ambiguous `export *` produced an invented edge.** Fixed in `e5a4d36`.
- **Top-level function and class callees were dropped.** My own regression, caught by three snapshot tests. Fixed before the final run.
- **Stale markers removed before their phase was complete.** The 8.4 renditions were restored, the harness was fixed to check diagnostics, and the markers were removed again in `ad36f6b`.
- **A stray probe file was committed to the working tree.** My mistake. It was deleted, and no commit contains it.

## Open items

- **Pending markers, owned by other phases:**
  - `2.5` (three JS/TS renditions): JS/TS method calls on typed receivers, constructor results and `super` are matched by name only.
  - `12.3` (three renditions): module-level shared state. No `writesState` edges are produced.
  - `11.3` (one Rust rendition): Rust data lineage. No `generates` or `consumes` edges are produced.
- **Phase 10.1:** the macro-generated-item negative passes, but it does not check the invocation `calls` edge that 10.1 requires. Phase 10 adds that expectation.
- **Symbol-level `abi`:** deferred to schema work.
- **`mod` items inside a function body** are not read, by design.
- **Macro arguments** wait for Phase 10.
- **`#[no_mangle]` in binary crates** is not exported, following the 9.4 rule for lib and proc-macro crates only.
- **JS/TS ambiguity check** looks one level into the re-export chain. Deeper chains are not checked.
- **JS/TS default exports** are named by their declaration, not by `default`. This is a known change, recorded in the contract.
- **Matrix rows** for Python and JS/TS receivers still need a review pass under Phase 13.
- **Snapshot baselines:** no file under `test/snapshots/` changed in Phase 9 (checked with `git log` over that path). The JS/TS corrections in `e5a4d36` did not move any committed baseline.

## Next

Phase 10: Rust macros, compile-time includes and build scripts. The first scenario is the macro-generated-item negative, which needs its invocation `calls` expectation added.
