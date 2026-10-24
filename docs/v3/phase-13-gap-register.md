# Phase 13 Gap Register

Status of each gap from the 13.1 table. Each gap ends as **Fixed** (its scenarios pass), **Not applicable** (with a semantic reason), **Deferred** (listed in `docs/v3/deferred.md`), or **Open**.

## Gate

`npm run test:accuracy` (`src/analyzer/parity-accuracy.test.ts`): recall 100% and zero declared false positives, per language, over non-pending renditions. Current: 124 renditions, 100% recall, zero false positives, zero pending.

Not yet measured: the performance budget on synthetic repositories (1,000 files, about 150k lines, plan 0.7).

## Coverage gaps

| Matrix row                   | Status       | Notes                                                                                                                                                                                                                   |
| ---------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9 Type references            | Fixed        | JS/TS emits `references` for a repository type named in a type position. Python annotations are owned by the module, since they run when the `def` runs.                                                                |
| 16 Dynamic module loads      | Fixed        | Rust `libloading::Library::new` is reported as `dynamic-module-specifier`, for both a literal path and a computed one. The detail text tells them apart. Recommendation 3, applied.                                     |
| 17 Resources                 | Fixed        | JS/TS resources are configured under `protocols.resources`, as recommendation 2 set. A plain file read (`readFileSync`, `open`, `std::fs`) stays a data read. Scenarios in all three languages, including the negative. |
| 21 Packages                  | Fixed        | Python libraries emit `packageRoot` to each top-level package's `__init__.py` or top-level module. Test packages and `setup.py`/`conftest.py` are excluded.                                                             |
| 23 Source annotations        | Fixed        | All three languages. Expectations check confidence. Annotations sit inside the owner's body.                                                                                                                            |
| 25 Test code tagging (D5)    | Fixed        | File nodes carry `tests: true` by path convention (`analyzer/test-files.ts`). `include.tests: false` leaves test code out of the graph. Recommendation 1, applied.                                                      |
| 20 Process execution         | Out of scope | Phase 14.5.                                                                                                                                                                                                             |
| 22 Cross-language boundaries | Out of scope | Phase 14.                                                                                                                                                                                                               |

## Rust findings from the real-world run (`docs/v3/real-world-corpus.md`)

| Finding                                                                    | Status                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enum variant glob `use Enum::*` unresolved                                 | Fixed. The glob resolves to the enum's file. Variant names are not enumerated, so no edge is guessed. Parity scenario.                                                                                                             |
| Private `use` in a crate root, used by children through `crate::`          | Open. Not reproduced by the synthetic scenario, which passes. The Tauri cases need a closer repro: generic types (`crate::EventName<&str>`), and a `pub mod` gated by `cfg`.                                                       |
| Integration test uses its package library (`demo::help`)                   | Open for the real case. The synthetic scenario passes. The async-trait failure is a proc-macro attribute path (`use async_trait::async_trait;`), a different cause.                                                                |
| Pydantic `crate::errors`, `super::CombinedSerializer`                      | Open. Not triaged.                                                                                                                                                                                                                 |
| `quote!` bodies analyzed as code (e.g. tauri-macros `std::result::Result`) | Open. New finding. Tokens inside an unknown macro are generated code, not paths the crate resolves. Plan 10.1 says repository macro tokens are not analyzed, and this should extend to external macros whose tokens are templates. |
| Glob paths through an umbrella crate (`grep::printer`, ripgrep)            | Open. Suspected re-export under an alias. Not confirmed.                                                                                                                                                                           |
| Trybuild fixtures in `tests/ui/` get `unreachable-module`                  | Kept as designed (plan 8.4). Decision: they are tagged as tests, so `include.tests: false` removes them.                                                                                                                           |

## Release notes (Phase 13 engine changes so far)

- JS/TS now emits `references` for type positions that name a repository type. One existing test was narrowed.
- Python libraries now emit `packageRoot` edges to their entry files.
- File nodes gain an optional `tests: true` field (V3 D5). Existing maps without it read as before.
- The `include` option accepts either the v2 array of globs, or an object `{ patterns, tests }`. `tests` defaults to true. The schema allows both forms.
- Rust `libloading` observations use `dynamic-module-specifier` for literal and computed paths. The previous reason `unresolved-module-path` is no longer reported for them.
- Rust enum variant globs connect the importing file to the enum's file.
- The Python `syntax` label is `lexing`. Rust `modules` is `modules and imports`.

## Phase 12 known limits

Recorded in `docs/v3/deferred.md`, with reasons. The Python shadowing and lambda items were fixed in Phase 13 (scenarios pass); the rest are deferred.
