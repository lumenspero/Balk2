# Phase 13.3 Real-World Corpus

Public repositories that Phase 13.3 runs every language against. Each one is pinned to the commit below, so a run can be reproduced.

## Repositories

| Kind (plan)                         | Repository                       | Commit    | Checkout                                                                            |
| ----------------------------------- | -------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| Python: src-layout library          | `pallets/click`                  | `2247b35` | Full                                                                                |
| Python: Django-style app            | `djangogirls/djangogirls`        | `3a0d52a` | Full                                                                                |
| Python: data pipeline with pandas   | `pandas-dev/pandas` (see note)   | `6b1799d` | Sparse: `pandas/io`, `pandas/core/frame.py`                                         |
| Python: namespace-package monorepo  | `googleapis/google-cloud-python` | `eb8a766` | Sparse: `packages/google-api-core`, `packages/google-cloud-core`                    |
| Rust: multi-crate workspace         | `BurntSushi/ripgrep`             | `6892bc2` | Full                                                                                |
| Rust: wasm-pack app                 | `rustwasm/wasm-pack-template`    | `a6a6658` | Full                                                                                |
| Rust: maturin / PyO3 package        | `pydantic/pydantic-core`         | `383eb95` | Full                                                                                |
| Rust: proc-macro crate and consumer | `dtolnay/async-trait`            | `20fffdd` | Full                                                                                |
| Rust: Tauri app                     | `tauri-apps/tauri`               | `1fc6d9c` | Sparse: `crates/tauri`, `crates/tauri-build`, `crates/tauri-macros`, `examples/api` |
| JS/TS: V2 real-world set            | Not run in this pass             |           |                                                                                     |

**Note on pandas.** The plan asks for a data pipeline that uses pandas. `pandas-dev/pandas` is pandas itself, a library, so it stands in for the pandas-heavy codebase. A pipeline repository would be a better match if one is found.

## Results (first run, no fixes applied)

Produced by `buildConnectionGraphDetailed` on each checkout. No oracle comparison has run yet. Counts are the raw output, not verified against a toolchain.

| Repository                      | Time  | Files | Symbols | Relationships | Syntax errors | Module problems | Unresolved observations                                                                                |
| ------------------------------- | ----- | ----- | ------- | ------------- | ------------- | --------------- | ------------------------------------------------------------------------------------------------------ |
| pallets_click                   | 6.2s  | 102   | 1813    | 1981          | 0             | 0               | dynamic-module-specifier 1, unresolved-callback 21                                                     |
| djangogirls_djangogirls         | 17.2s | 317   | 3030    | 2089          | 9             | 0               | dynamic-event-name 9, unknown-event-receiver 98, unresolved-callback 6                                 |
| googleapis__google-cloud-python | 7.7s  | 159   | 2899    | 2812          | 0             | 0               | unresolved-callback 17                                                                                 |
| pandas-dev__pandas              | 10.1s | 57    | 2110    | 2581          | 0             | 0               | dynamic-registry-key 1, unresolved-callback 30                                                         |
| BurntSushi_ripgrep              | 2.7s  | 115   | 3666    | 6515          | 0             | 0               | dynamic-include-path 1, unresolved-callback 33, unresolved-module-path 125                             |
| rustwasm_wasm-pack-template     | 0.0s  | 4     | 4       | 6             | 0             | 0               | none                                                                                                   |
| pydantic_pydantic-core          | 16.5s | 251   | 4955    | 8703          | 0             | 0               | dynamic-module-specifier 1, dynamic-registry-key 1, unresolved-callback 127, unresolved-module-path 96 |
| dtolnay_async-trait             | 0.3s  | 29    | 561     | 276           | 0             | 16              | unresolved-module-path 57                                                                              |
| tauri-apps__tauri               | 5.1s  | 124   | 3051    | 5916          | 0             | 0               | dynamic-include-path 4, unknown-event-receiver 2, unresolved-callback 46, unresolved-module-path 121   |

No crashes. Every run finished.

## Triage (Rust unresolved paths)

Each finding below comes from reading the source. Status is **open** until a fix passes its parity scenario.

1. **Private `use` visible to child modules.** Tauri's `crate/src/lib.rs` has a private `use self::event::EventName;`. Other modules refer to it as `crate::EventName`, which Rust allows because private items in the crate root are visible to descendants. The resolver does not follow it. Accounts for most of the Tauri `crate::` failures.
2. **Enum variant glob.** `use self::StandardStreamKind::*;` in ripgrep's `crates/cli/src/wtr.rs` names an enum declared in the same file (line 62). The resolver does not expand variant globs. Also seen for `DirEntryInner`, `GlobSetMatchStrategy` and `HyperlinkFormatErrorKind`.
3. **Implicit library dependency of test targets.** `dtolnay/async-trait` `tests/test.rs` uses `async_trait::async_trait`. Plan 7.3 says every test target implicitly depends on its package's library. Not applied to auto-discovered integration tests.
4. **`pub use` re-exports under an alias.** ripgrep's `grep::printer`, `grep::searcher`, `grep::cli`, `grep::matcher` (about 70 failures). Suspected, not yet confirmed: the `grep` crate in `crates/grep` re-exports sub-crates under other names. To confirm by reading `crates/grep/src/lib.rs`.
5. **Pydantic `crate::errors` and `super::CombinedSerializer`.** About 80 failures. Not yet triaged. May be the same as finding 1 or 4.
6. **Trybuild fixtures.** `dtolnay/async-trait` `tests/ui/*.rs` are compile-fail fixtures, not crate modules. The analyzer reports 16 `unreachable-module` diagnostics for them. Per plan 8.4 these are correct as reported. Whether they belong in the graph is a decision.

Python observations (`unresolved-callback`, 6 to 127 per repository) are reported as designed. None have been reviewed for whether they could resolve.

Djangogirls `static/source/js/event.js` has 9 syntax errors. The file contains HTML comments inside JavaScript, so the errors are correct.

## Next

Fix findings 1 to 5 in Phase 13.3, each with a parity scenario first. Then run the oracles: `rust-oracle` for the module trees, and the Python oracles on the Python repositories.

## Second run (after the Phase 13 decisions and the enum fix)

Rust repositories only. Same checkouts.

| Repository             | Files | Test files tagged | Unresolved module paths (first run → second run) |
| ---------------------- | ----- | ----------------- | ------------------------------------------------ |
| BurntSushi_ripgrep     | 115   | 15                | 125 → 94                                         |
| dtolnay_async-trait    | 29    | 19                | 57 → 57                                          |
| tauri-apps__tauri      | 124   | 4                 | 121 → 121                                        |
| pydantic_pydantic-core | 251   | 121               | 96 → 96                                          |

The drop in ripgrep is the enum-glob fix. The other counts are open findings in `docs/v3/phase-13-gap-register.md`.

## Third run (after the Rust resolver fixes)

Rust repositories only. Same checkouts. The count is `unresolved-module-path` entries.

| Repository             | Second run | Third run | What changed                                                                                                                      |
| ---------------------- | ---------- | --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| BurntSushi_ripgrep     | 94         | 87        | Library crates bound first                                                                                                        |
| dtolnay_async-trait    | 57         | 57        | No change. Proc-macro attribute paths (open)                                                                                      |
| tauri-apps__tauri      | 121        | 38        | Inherited edition 2021 fallback (66 paths), `cfg` field literals, type-position shadowing, library-first ordering                 |
| pydantic_pydantic-core | 96         | 94        | Library-first ordering. Remaining paths are macro-generated items (`error_types!`, `serialization_mode!`, `combined_serializer!`) |

The remaining Tauri paths are macro-generated (`gen_wrappers!`, `swift!`), the `quote!` and proc-macro cases, and an open umbrella-crate case. Each is listed in `docs/v3/phase-13-gap-register.md`.

## Fourth run (after the macro reason and the quote fix)

Rust repositories only. The first number is `unresolved-module-path`, which are misses the analyzer cannot explain. The second is `macro-generated-item`, which are paths to names a macro call in the same module may generate.

| Repository             | Third run | Fourth run (misses / macro) | What changed                                                                                                                                         |
| ---------------------- | --------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| BurntSushi_ripgrep     | 87        | 87 / 281                    | Macro reason. Misses are the `grep::` umbrella (open)                                                                                                |
| dtolnay_async-trait    | 57        | 57 / 0                      | No change. Proc-macro attribute paths (open)                                                                                                         |
| tauri-apps__tauri      | 38        | 1 / 119                     | Macro reason. One miss: `tauri_plugin_sample::PingRequest`, a glob re-export from another repository crate (open)                                    |
| pydantic_pydantic-core | 94        | 0 / 550                     | Macro reason, and a use that imports a macro-generated name now binds it, so the names re-exported through `errors` and `type_serializers` are known |

Counts rose for macro-generated entries because a mention of a name bound by a failing `use` used to be silent. It is now reported at each mention with the macro reason, the same as any other unresolved path.

## Fifth run (after the sweep binding and the reason check)

| Repository             | Misses | Macro-generated | What changed                                                                                                           |
| ---------------------- | ------ | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| BurntSushi_ripgrep     | 74     | 0               | Macro reason was wrongly applied to plain misses (281 false entries removed). Sibling-crate names now bound (87 to 74) |
| dtolnay_async-trait    | 57     | 0               | No change. Proc-macro attribute paths (open)                                                                           |
| tauri-apps__tauri      | 0      | 118             | Sibling glob re-export fixed (`PingRequest`)                                                                           |
| pydantic_pydantic-core | 0      | 550             | No change                                                                                                              |

The earlier run reported a macro-generated count for ripgrep that was a bug: a plain miss was classified as macro-generated. That count is gone.
