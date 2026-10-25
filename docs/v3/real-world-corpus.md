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

## Sixth run (Python oracles on the real-world repositories, CPython 3.12)

Inventory oracle: CPython's `ast` (`test/python-oracle/dump_inventory.py`) compared with Balk2's inventory (`src/analyzer/python/oracle-inventory.ts`), file by file. Only `.py` files are compared.

| Repository                      | Files | CPython syntax errors | Balk2 mismatches |
| ------------------------------- | ----- | --------------------- | ---------------- |
| pallets_click                   | 91    | 0                     | 0                |
| djangogirls_djangogirls         | 293   | 0                     | 0                |
| googleapis\_\_google-cloud-python | 157 | 0                   | 0                |
| pandas-dev\_\_pandas            | 57    | 0                     | 0                |
| pydantic_pydantic-core          | 124   | 0                     | 0                |

Import-resolution oracle: `test/python-oracle/resolve_oracle.py` imports the modules it checks, so it runs package code from these repositories. It was run under CPython 3.12 in a sandbox virtual environment, with the third-party packages the repositories import installed from PyPI. The compiled extensions were built from source for pandas (shallow clone at `199f52b`, built with meson-python in chunks). For pydantic-core, the compiled extension from the PyPI wheel of the same version (2.41.5) was used, since no Rust toolchain is installed. The pandas scope is the library code (297 files); test files were not compared. The fixture run (CI's `test/python-resolution`) passes, 9 of 9.

Oracle defects fixed in `resolve_oracle.py`:

- `Case.fresh()` removed every module loaded since the start, including standard-library modules, which crashed the interpreter. It now removes only modules loaded from the case directory.
- A built-in or frozen module (such as `itertools`) was classified as a namespace package. It is now external.
- A `from` import of a module that is not installed was classified as unresolved. It is now external.
- A name that is a submodule (`from click import types`) was reported at the package's `__init__.py`. It is now reported at the submodule's own file.
- Reading an attribute can raise (Django's settings object does without configuration). Such reads now fall back to the module's namespace.
- `if TYPE_CHECKING:` blocks are not probed, since they never run.

Balk2 defects fixed in the resolver:

- A name a module provides through a star import of a module that binds it was reported unresolved (`from pkg.types import is_string`, where `pkg/types` star-imports `pkg/dtypes/api`).
- A name a module provides through a module-level `__getattr__` (PEP 562) was reported unresolved (pandas' `Block`).
- Aliased `TYPE_CHECKING` guards (`import typing as t; if t.TYPE_CHECKING:`) were not recognized as type-only.

Decisions:

- A missing name under a namespace package (such as `google`, which the repository shares with installed distributions) is external, not unresolved.
- A compiled extension has a Python stub (`.pyi`) in the repository. The oracle reports the compiled `.so`, and Balk2 reports the stub, since the stub is the only source file in the repository. Kept as is.
- When a package's `__init__.py` binds a submodule name explicitly, Balk2 reports the package binding, and the oracle reports the submodule's own file. Both point at the same module. Kept as is.

Result: 800 of 11,685 entries differ (pandas library 7,321; djangogirls 1,004; google-cloud-python 1,445; click 687; pydantic-core 1,228). The differences are:

| Cause                                                                                                                                                              | Entries |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| pandas: a compiled extension has a `.pyi` stub, and the oracle reports the `.so` (stub convention)                                                                  | 457     |
| pydantic-core: the same stub convention                                                                                                                             | 32      |
| pandas: package binding vs submodule (convention)                                                                                                                  | 7       |
| pandas: `pandas_parser` and `pandas_datetime` are compiled from C sources and have no Python source in the repository, so Balk2 has no file to report                | 2       |
| djangogirls: Django apps whose models cannot be imported without a configured Django project                                                                       | 277     |
| google-cloud-python: package binding vs submodule (convention, 8). Test helpers imported relatively from outside a package, which pytest resolves at runtime (14)      | 22      |
| click: Windows-only names (`windll`, `WINFUNCTYPE`) and a platform-specific module                                                                                  | 3       |

The real-world comparison is a diagnostic, not a CI check. The repository test fails on all five repositories, because it counts the convention differences above and the Django cases.

## Seventh run (Rust module oracle on the real-world repositories, rustc 1.99.0)

Rust module oracle: the driver compiles each crate root with `rustc --emit=dep-info` and compares the `.rs` files it reads with the files Balk2 reports as reached when the crate is active (`reachedWhenActive`). `rustc` came from the conda-forge `rust` 1.99.0 package with its `rust-std` package, unpacked without root; cargo was not available because crates.io is not reachable from this environment. The comparison is per crate root, so a crate whose dependencies are not on disk cannot be compiled and is reported as `rustc-no-depinfo`.

| Repository | Crates | Match | Differs | No dep-info |
|------------|-------:|------:|--------:|------------:|
| `BurntSushi/ripgrep` | 21 | 20 | 0 | 1 |
| `dtolnay/async-trait` | 4 | 4 | 0 | 0 |
| `rustwasm/wasm-pack-template` | 2 | 2 | 0 | 0 |
| `pydantic/pydantic-core` (Rust crate) | 4 | 3 | 0 | 1 |
| `tauri-apps/tauri` (sparse checkout) | 10 | 10 | 0 | 0 |
| **Total** | **41** | **39** | **0** | **2** |

The two crates without dep-info fail for environment reasons, not resolver reasons: `crates/grep/src/lib.rs` in ripgrep names the sibling crate `grep_cli` in `pub extern crate grep_cli as cli;`, which a single-root compile cannot find; `src/lib.rs` in pydantic-core uses `env!("CARGO_PKG_VERSION")`, which only cargo sets.

Problems found while running the driver, all in the driver and none in Balk2:

- The dep-info comparison first counted files that `include_str!` and `include_bytes!` read (shell completions, help templates, a test fixture). The repository oracle filters to `.rs` (`rustcReads`); the driver did not. Fixed by applying the same filter.
- Dep-info files were named after the crate name, so every `src/lib.rs` wrote to the same file and read another crate's output. Fixed by keying the file on the crate path.
- The driver test used vitest's default 30-second timeout, which the full run exceeds.

Rust module oracle test (`BALK2_RUST_ORACLE=1`) passes 8 of 8 on rustc 1.99.0.

Previously blocked: rustc 1.75.0 from Ubuntu 22.04 could not compile ripgrep, which uses edition 2024. The conda-forge toolchain resolves this.
