# Session Delta: Phase 11 Complete

**Range:** `a396785` (phase 10 exit criteria) to `9f52cce` (python duckdb sql). 19 commits, 33 files, +4,706 / -29 lines.
**Status:** Phase 11 is complete. Items 11.1 through 11.5 are implemented in JS/TS, Python and Rust, and every decision the plan left open is recorded in `docs/v3/phase-0-contract.md` or `docs/v3/python-changes.md`. The exit criterion is met: the parity data scenario ("data written by one file and read by another") passes in all three languages with no `pending: '11…'` marker left, the full Python → JSON → Rust → Parquet → TS fixture passes (`src/analyzer/data-lineage-pipeline.test.ts`), and no file under `test/snapshots/` changed in this range.
**Verification:** the user ran `npm run verify` after the final commit and reported all checks green. This agent ran the Phase 11 verify command (`src/facts/data`, `src/analyzer/mixed-accuracy`, `src/analyzer/parity`: 3 files, 89 tests, passing) before the last DuckDB commit, the full 187-file suite in 14 batches before the 11.5 commit, and the related test files (33 to 41 per change) after each later change. Those related runs were all green.

## Commits

| Commit    | Subject                               | Files | Lines (+/-) | Notes                                                              |
| --------- | ------------------------------------- | ----- | ----------- | ------------------------------------------------------------------ |
| `65e1b97` | 11.1 complete                         | 9     | +435 / -6   | —                                                                  |
| `7926751` | 11.4 complete                         | 9     | +217 / -5   | —                                                                  |
| `5cc7d39` | 11.5 complete                         | 8     | +225 / -18  | —                                                                  |
| `de756f6` | 11.2 complete                         | 9     | +384 / -30  | —                                                                  |
| `9da67fd` | 11.3 complete                         | 6     | +402 / -2   | —                                                                  |
| `ca17303` | 11.5 python constant flows            | 4     | +202 / -24  | Module constants and `Final` values carried to catalog calls.      |
| `63eaf3d` | 11.4 placement move                   | 13    | +920 / -82  | Bare-path placement moved into one shared rule for every language. |
| `1a538b5` | fetch handling                        | 8     | +177 / -20  | Served `fetch` paths, placed by the `public/` and package bases.   |
| `6ddab2a` | file::options() and DuckDB leftovers  | 7     | +227 / -6   | `File::options()` chains; DuckDB SQL in JS/TS.                     |
| `57b22cf` | polars dataframe                      | 4     | +62 / -5    | Polars writers and `LazyFrame` sinks.                              |
| `d18e94e` | python import rebinding               | 3     | +59         | A name rebound by an import is not typed from its earlier value.   |
| `1c4fd67` | rust module-path item                 | 5     | +298 / -39  | `crate::`, `self::`, `super::` paths to constants.                 |
| `23d320f` | 11.4 data.pathBase override           | 12    | +269 / -13  | `data.pathBase` in config, per language or for all.                |
| `dd9f4f0` | 11.5 single assignment local bindings | 8     | +299 / -15  | Function locals in Python, `let` in Rust, `let`/`var` in JS/TS.    |
| `e8ddf26` | 11.3 Rust readers and writers         | 4     | +137 / -17  | `csv` builder chains, Polars `LazyCsvReader`, `LazyFrame::scan_*`. |
| `d97c9ed` | 11.1 JS/TS Catalog                    | 4     | +81 / -1    | `parquetjs` readers and writers; static methods on imports.        |
| `28c897c` | 11.2 python anchors                   | 8     | +310 / -14  | `__file__`-anchored paths, `os.path.join`, pathlib `/`.            |
| `c397652` | 11.5 rust pub use                     | 6     | +150 / -17  | Constants re-exported by `pub use`, followed to their declaration. |
| `9f52cce` | python duckdb sql                     | 7     | +149 / -12  | DuckDB SQL in Python; SQL scanner shared with JS/TS.               |

## What Phase 11 built

- **Catalog** (`src/facts/data-catalog.ts`): one table of library APIs with direction, language and argument position. Covers `fs` and `fs/promises`, streams, moves, `fetch`, `parquetjs`, `csv` and Polars Rust builders, `pandas`, `polars`, `pyarrow` (Parquet, CSV, Feather), `numpy`, `shutil`, `sqlite3`, `pathlib.Path`, DataFrame methods and DuckDB.
- **Engine** (`src/facts/data-engine.ts`): one `runDataEngine` for every language. A catalog call has its direction from the catalog, at high confidence. A call the catalog does not match keeps the keyword rule at low confidence.
- **Placement** (`src/facts/path-value.ts`): one rule for bare relative paths. One existing candidate wins, several give the first, and none gives the repository root, which is always tried last. `data.pathBase` changes the order for every language or per language.
- **JS/TS** (`src/analyzer/data-api.ts`, `src/analyzer/duckdb-sql.ts`): checker-based callee resolution, `require` bindings, `const`/`let`/`var` string flows, served `fetch` paths, DuckDB SQL.
- **Python** (`src/analyzer/python/data-apis.ts`): receiver typing for `Path`, pandas and Polars frames, DuckDB connections; import rebinding; module and function-local constants; anchored paths; DuckDB SQL.
- **Rust** (`src/analyzer/rust/data-apis.ts`, `module-tree.ts`): `OpenOptions` and `File::options()` chains, csv builder chains, `let` and `const`/`static` constants, `crate::`/`self::`/`super::` paths, `pub use` re-exports.
- **Shared SQL scanner** (`src/facts/duckdb-sql.ts`): one definition of which files a DuckDB statement reads and writes, used by JS/TS and Python.
- **Schema and config**: `data.pathBase` in `schemas/balk2.schema.json` and `src/config/path-base-config.ts`.

## Decisions

1. **Bare-path placement (option 2).** One candidate wins, several give the first, none gives the repository root, and the root is always last. Confirmed by the user.
2. **Served `fetch` paths.** A high-confidence edge only when a candidate file exists in the `public/` folder, the package, or the root. Otherwise the keyword edge stays low. The user accepted this after rejecting a version that hobbled placement.
3. **Handle loads have no catalog entries.** `json`, `pickle`, `csv`, `yaml` and `tomllib` read or write a handle. The path belongs to the `open` call that made it, which is already matched.
4. **Arrow in JS/TS and hyparquet are not in the catalog.** Arrow bytes are read through `fs`, which matches. hyparquet takes a buffer or an async buffer, not a path.
5. **Pickle and Feather destinations give no edge.** `.pkl` and `.feather` are not data formats in `src/data/formats.ts`. The catalog entries exist, so an edge appears once a format is added.
6. **DuckDB database files give no edge.** Neither `duckdb.connect(path)` nor `new duckdb.Database(path)` is an edge. The SQL inside them is.
7. **Anchored paths are exact.** A path built from `__file__` resolves against the file's own directory and is not searched as a bare path. A path that climbs above the root keeps its `../` parts.
8. **Rust `let` is block-wide, not sequential.** A `let` later in a block still applies to an earlier use in that block.
9. **JS/TS `let`/`var` flows only if nothing in the enclosing function reassigns it.** The check is conservative, so any reassignment in the function stops the flow.
10. **Rust `pub(…)` counts as public** for re-exports. This is a crate-wide approximation.
11. **`shutil.move` is not in the catalog.** The plan lists only `shutil.copy*`.

## Bugs found and fixed in this phase

- **A local `fetch` drew a high edge.** `fetch` was a certain keyword read. Fixed: `fetch` is now a low keyword read unless the catalog resolves it.
- **Served `fetch` placement was too strict.** The first version hobbled placement, and the user rejected it. Fixed with the served base order.
- **SQL with quotes matched nothing in Python.** `stringValue` rejects quotes, and SQL is full of them. Caught by the new tests before the commit. Fixed with a SQL-specific reader.
- **Anchored paths duplicated edges.** The keyword pass also saw the literal inside the anchored path. Fixed: an anchored fact claims its literal's last segment.
- **Anchored paths above the root lost their edge.** The keyword pass then added a bare high edge. Fixed: the path is kept as written, and the literal is claimed.
- **Test helpers were scoped inside another `describe`.** Caught while adding tests. Fixed with local helpers in each block.
- **A negative test matched the keyword rule.** The name `ParquetReader` contains `read`. Fixed by renaming the fixture. The keyword behaviour itself is unchanged (see open items).
- **Schema reformatting churned unrelated lines.** Fixed by inserting the `pathBase` block as plain text, so the diff adds lines only.
- **Plan verify lines matched no tests.** Four lines pointed at paths that do not exist (Phase 10 `rust/macros` and `rust/build`, Phase 13 `*-accuracy`, Phase 14 `bindings`). Fixed with real paths and notes for directories a later phase creates. I had also wrongly reported `src/analyzer/parity` and `src/facts/data` as missing. They are valid substring filters.

## Open items

- **Keyword rule for unmatched calls.** A call the catalog does not match still goes through the keyword rule, and a keyword in its text gives a high edge. `ParquetReader` contains `read`, so an unmatched `ParquetReader.openFile` gets one. This is existing behaviour. Changing it may move parity expectations, so it needs its own decision.
- **Known gaps, by design:**
  - Rust glob re-exports (`pub use …::*`) are not followed.
  - Rust glob imports (`use polars::prelude::*`) are not followed.
  - Rust `LazyFrame` sink methods need receiver typing, which Rust lineage does not track.
  - Python anchors through a constant imported from another file are not followed, and neither are anchors inside an f-string.
  - DuckDB SQL held in a variable, or built by formatting or concatenation, is not followed.
  - The Python keyword dedupe matches the literal's last path segment, which is a heuristic.
- **Uncommitted formatting in the repo.** `schemas/balk2.schema.json`, `docs/v3/phase-0-contract.md` and `docs/v3/python-changes.md` have Prettier reflows only (line wrapping, one blank line). No content changed. Commit or discard them.
- **Full suite.** The last full 187-file run was before the 11.5 commit. Later commits were checked with related batches and your `npm run verify`.
- **Planned later:** the `test:accuracy` script (Phase 13) and the `ts-oracle` CI job (Phase 16) do not exist yet, and the plan says so.
- **Phase 9 marker.** The `11.3` pending marker in the Phase 9 delta (Rust data lineage) is cleared. No `pending: '11…'` marker remains in the source.

## Next

Phase 12: mechanism parity for events, registries, state, callbacks, loads and resources (`balk2-v3-implementation-plan.md`, Phase 12). The module-level shared-state renditions (`pending: '12.3'`) belong to that phase.
