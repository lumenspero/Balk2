# Phase 13 Gap Register

Produced by 13.1 (`npm run test:accuracy`) and 13.2. Each gap ends as **Fixed**, **Not applicable** (with a semantic reason), or **Deferred** (needs explicit approval and a tracking issue). No Deferred cell is set without approval.

## Budgets (13.2)

Enforced in `src/analyzer/parity-accuracy.test.ts`, for every language, over non-pending renditions: recall 100% and zero declared false positives. Current result: met for JavaScript, Python and Rust (93 renditions).

Not yet measured: the performance budget on synthetic repositories (1,000 files, about 150k lines, plan 0.7). The 13.1 time column covers only the small corpus fixtures.

## Coverage gaps (no corpus family in the language)

The gap is read from family labels in the 13.1 table. Each entry needs a check that no scenario covers it under another label before it is fixed.

| Matrix row                   | JS/TS | Python | Rust | Proposed disposition                                         |
| ---------------------------- | ----- | ------ | ---- | ------------------------------------------------------------ |
| 9 Type references            | none  | none   | none | Fix: add scenarios                                           |
| 16 Dynamic module loads      | none  | 1      | none | Fix: add JS and Rust scenarios (Rust is an observation only) |
| 17 Resources                 | none  | none   | none | Fix: add scenarios                                           |
| 21 Packages and manifests    | none  | none   | none | Fix: add scenarios (phases 4 and 7 are done)                 |
| 23 Source annotations        | none  | none   | none | Fix: add scenarios (phase 12.7 is done)                      |
| 25 Test code tagging (D5)    | none  | none   | none | Fix: add scenarios                                           |
| 20 Process execution         | none  | none   | none | Out of scope for 13: planned for phase 14.5. Confirm.        |
| 22 Cross-language boundaries | none  | none   | none | Out of scope for 13: planned for phase 14. Confirm.          |

## Label drift

- `modules` (Rust) and `modules and imports` (Python) describe the same family.
- `syntax` (Python, Rust) and `syntax diagnostics` (all three) overlap.

Proposed: rename to the matrix row names. The label is not used by any assertion, so this is a rename only.

## Known limits from Phase 12 (`docs/v3/session-delta-phase-12.md`)

These are recorded as limits. Under the plan, each one needs a fix or an approved Deferred.

- Python: a builtin shadowed by a local is not checked; a `lambda` callback is unresolved; `files()` through a variable is not followed; a local that shadows an import inside a function is not checked; a subscript write `d[k] = v` is not recorded.
- Rust: `Library::new` reached through `use libloading::Library` is not read; `lock()` is recorded as a read and the `access: "lock"` annotation is not emitted; writes inside a `thread_local!` `with` closure are not read; a configured singleton that matches no static is ignored without a diagnostic.
- Matrix rows 6 (Python and Rust): field and call-result receivers have no type. This is a scope decision in the plan (out of scope, section "Type inference beyond the local type rules"), not a gap. Proposed: Not applicable, with that reason.

## Excluded from the table

The V2 accuracy suites (`event`, `registry`, `state`, `global`, `mixed`, `module-load`) report their own metrics and are not in the 13.1 table yet.

## Decisions needed

1. Approve the fix list above, or name rows to defer.
2. Approve Deferred or Not applicable for each Phase 12 limit.
3. Confirm that rows 20 and 22 are out of scope for Phase 13.
4. Confirm the label renames.
