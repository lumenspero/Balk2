# Session Delta: Phase 12 Complete

**Range:** `5b88823` (phase 11 finished) to `4d069d8` (12.8 JS renditions and P12 exit check). 38 commits, 82 files, +7,580 / -483 lines.
**Status:** Phase 12 is complete against its exit criterion: every mechanism scenario in the parity corpus passes in every language where the matrix says Supported, and no `pending:` marker is left in `src/testing/`. The three JS renditions that were pending on Phase 2.5 were closed by a checker-based fix in `handleCall`, not by moving the matrix cells to Partial. The V2 negative tests have counterparts in Python and Rust: the same key in two registries, the same event name on two emitters, and a shadowed name that is not shared state.
**Verification:** This agent ran these after the final changes: `npx tsc --noEmit` (clean); eslint and Prettier on the changed files (clean after one formatting fix); the Phase 12 verify command `npx vitest run src/facts src/analyzer/parity accuracy` (22 files, 426 tests, passing); and the full suite in chunks, because a single run exceeds the tool timeout. The chunks were the non-JS groups (135 files, 1,607 tests), the top-level analyzer tests (73 files, 1,078 tests) and the top-level `src` tests (15 files, 134 tests). All passed. A single background full run did not finish. The user reported all checks green after the final commit.

## Commits

| Commit    | Subject                                          |
| --------- | ------------------------------------------------ |
| `5b88823` | phase 11 finished (base, not in range)           |
| `ec6eb02` | 12.1 complete                                    |
| `cf5cb8a` | 12.2 repository classes with register decorators |
| `3f76c56` | 12.2 checkpoint                                  |
| `95a7297` | parameter name injection                         |
| `2bbbba0` | 12.2 attribute registrations                     |
| `f55e07d` | rust attributes                                  |
| `e568284` | rust map items                                   |
| `c3cb981` | tauri lookup                                     |
| `a42165b` | 12.2 python route recipe                         |
| `82a6f82` | rust static maps                                 |
| `179ea2d` | phf tables / lazy_static!                        |
| `c296862` | 12.3 partial                                     |
| `aff2b8b` | 12.3 python module global                        |
| `dbded39` | 12.3 python cross module writes                  |
| `979b77e` | rust static mut                                  |
| `9facdba` | interior mutable statics                         |
| `cd06ba8` | 12.3 rust lazy_static!                           |
| `693528d` | 12.3 thread_local!                               |
| `10b379b` | 12.3 python configured singletons                |
| `e73f408` | 12.3 rust configured singletons                  |
| `061c8f4` | 12.3 singleton parity scenarios                  |
| `949168d` | 12.3 docs                                        |
| `0c52e82` | 12.4 python callback checkpoint                  |
| `e87101d` | 12.4 python from threading import                |
| `39fcb6f` | python built in callbacks                        |
| `5496c63` | 12.4 Rust passesCallback                         |
| `fdbbf6e` | 12.4 parity corpus                               |
| `b09a950` | 12.4 python receiver cases                       |
| `a013d20` | 12.4 self.run                                    |
| `ee71528` | 12.4 loop.call_soon                              |
| `bfed74a` | 12.5 partial python checkpoint                   |
| `55a96dd` | 12.5 python leftovers                            |
| `0944f99` | 12.5 rust callback                               |
| `f5302c1` | 12.6 complete                                    |
| `343b878` | 12.7 partial checkpoint                          |
| `7c709a3` | 12.7 rust source annotations                     |
| `e021391` | 12.8 doc                                         |
| `4d069d8` | 12.8 JS renditions and P12 exit check            |

## What Phase 12 built

- **Events (12.1):** Python `pyee`, `blinker` and Django-style signal receivers, gated on the receiver's resolved type. Rust event channels are Not applicable, because they are name-keyed. The `event-like` method protocol still applies to Rust types whose impls declare both a subscribe and an emit method.
- **Registries (12.2):** Python literal-key dict registration, `register('k', Cls)`, decorator registration (`@app.route`, which emits `routesTo` on lookup), entry points, and parameter-name injection. Rust map inserts and lookups with literal keys on static or locally resolvable maps, `phf` tables and `lazy_static!`. Attribute registrations (`protocols.registries[].attribute`) cover Tauri commands and decorator-based routes.
- **Shared state (12.3):** Python module globals written through `global` or `module.NAME = ...`, and `builtins.x`. Rust `static mut`, interior-mutable statics (atomics, `Mutex`/`RwLock`, `OnceLock`/`LazyLock`, `once_cell`, `lazy_static!`, `thread_local!`). Configured singletons work in all three languages.
- **Callbacks (12.4):** Python `Thread(target=)`, executor `submit`/`map`, `loop.call_soon`/`run_in_executor`, `atexit.register`, `signal.signal`, `key=` and function arguments to `sorted`/`min`/`max`/`map`/`filter`, `functools.partial`, and `self.run`. Rust `passesCallback` for a function path passed to a resolved function.
- **Dynamic loads (12.5):** Python `importlib.import_module` (relative imports with `package=`), `__import__`, `importlib.util.spec_from_file_location`, and `runpy.run_module`/`run_path`. Rust `libloading::Library::new` with a literal path, recorded only as an observation. A non-literal specifier in any language gives `dynamic-module-specifier`.
- **Resources (12.6):** Python `importlib.resources.files(pkg)` with `/` or `joinpath`, `read_text`/`open_text`, `pkgutil.get_data`, and configured template loaders.
- **Source annotations (12.7):** one grammar and one engine (`src/analyzer/source-annotation-engine.ts`) for all three languages. The comment forms are `//` for JS/TS and Rust, excluding doc comments, and `#` for Python, excluding strings.
- **Not applicable (12.8):** JS global-object traversal, `Reflect` metadata and Rust name-keyed events are recorded in the matrix with reasons.

## Decisions

1. **Annotations change confidence only.** `applyAnnotations` never creates an edge. An annotation that matches no edge is reported as a problem.
2. **Source overrides config** for the same relationship, under one merge rule for all languages.
3. **Rust `libloading` is an observation only.** It is recorded only when no repository symbol has that path, and the library's code is not analyzed.
4. **Python `__import__` is skipped** when a repository function or an import binding shadows it.
5. **`import pkg.mod` binds `pkg`** when `pkg` is external.
6. **A local binding of a shared name is not shared state.** This is the new negative scenario in the corpus.
7. **JS typed receivers link only to methods declared on repository classes.** The checker's receiver type must be a class. `super.m()` resolves through the same path, because `super` has the base class type.
8. **Matrix rows 6 and 8 stay Supported for JS/TS.** The decision was to fix the gap, not to downgrade the cells to Partial.
9. **Registry method names match only as bare calls.** A method of a common name cannot connect through a receiver by accident.
10. **Decorator names match as written.** `app.route` matches `@app.route(...)`, but not `@route(...)`.

## Bugs found and fixed in this phase

- **A probe found the matrix was wrong about JS.** The parity suite skips pending renditions, and the matrix had Supported for rows 6 and 8 while three JS renditions failed. Running the pending renditions in a scratch copy exposed the gap.
- **`readOf` returned early for `read_text`,** a method name shared with the function API. Fixed by falling through when no resource matches.
- **`applyModuleLoadEdges` had its arguments in the wrong order.** Fixed to `(edges, graph)`.
- **Annotation tests checked confidence `high`,** which is the default, so they could not see a change. Switched to `low`.
- **Rust annotation tests needed `buildConnectionGraphDetailed`** to see problems, since `buildConnectionGraph` returns only the graph.
- **A directive test needed a blank line** between the directive and its statement.
- **A test expected `app.templates` to be a package.** Fixed to `app` with `templates/card.html`.
- **Duplicate `export export`** in `js-source-comments.ts`, and an unused import. Both fixed.
- **Three snapshots went stale after the JS fix:** `events.txt`, `mixed-full-path.txt` and `mixed-other-receiver.txt`. Each new `calls` edge was checked against its fixture source before the snapshot was updated. This was missed because only part of the suite ran before the first report.
- **Prettier flagged the analyzer after the JS fix.** Formatted.

## Open items

- **`docs/v3/session-delta-phase-11.md` fails Prettier.** This is pre-existing and was not part of Phase 12. You said you would run Prettier on it.
- **Known limits, recorded in the docs:**
  - Python: a builtin shadowed by a local is not checked. A `lambda` callback is unresolved. `files()` chains through a variable are not followed. A local that shadows an import inside a function is not checked. A subscript write `d[k] = v` is not recorded.
  - Rust: a `Library::new` reached through `use libloading::Library` is not read. A `lock()` acquisition is recorded as a read, and the `access: "lock"` annotation is not emitted. Writes inside a `thread_local!` `with` closure are not read. A configured singleton that matches no static is ignored without a diagnostic. The state pass builds the repository model a second time, which adds time on large crates.
  - Row 6, Python and Rust: field and call-result receivers have no type. This is a scope decision in the matrix, not a gap.
- **Phase 13 requires approval** for any Deferred cell, plus a tracking issue. Phase 12 added no Deferred cells.

## Next

Phase 13, Accuracy Sweep and Gap Closure (`balk2-v3-implementation-plan.md`): run every corpus with per-language metrics and add `npm run test:accuracy` (13.1), resolve or move each gap to Not applicable or Deferred (13.2), then run the real-world repositories (13.3).
