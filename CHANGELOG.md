# Changelog

## 3.0.1

### Fixed

- A path that climbs out of the repository and still names a file through the file's own directory, such as `../package.json` from `src/`, now resolves to that file. Before, the connection map recorded the raw `../` path.

## 3.0.0

### Breaking changes

- **Connection map version 3.** `connection-map.json` now has `version: 3`. Version 1 and version 2 maps are still read, and `balk2 check` reports them as out of date until they are regenerated.
- **New union values.** Code that switches over these types must handle the new members:
  - `NodeKind`: `package`.
  - `SymbolType`: `struct`, `enum`, `trait`, `module`, `macro`, `variant`.
  - `StateRootKind`: `module`.
  - `PackageEcosystem`: `npm`, `python`, `cargo`. `PackageTargetKind`: `lib`, `bin`, `script`, `test`, `example`, `bench`, `build-script`, `proc-macro`.
  - `Evidence`: `manifest`.
  - Relationship types: `exports`, `declaresModule`, `dependsOn`, `packageRoot`, `executes`.
  - `UnresolvedReason`: `unresolved-module-path`, `macro-generated-item`, `ambiguous-star-import`, `dynamic-include-path`, `unresolved-binding`, `dynamic-command`.
  - `LoadKind`: `include-macro`, `dunder-import`, `spec-from-file`, `run-path`, `run-module`, `wasm-bindgen-module`.
- **Manifests are file nodes, not artifacts.** Manifest and toolchain files, such as `package.json`, `tsconfig*.json`, `Cargo.toml`, `pyproject.toml`, `setup.cfg`, `ruff.toml` and `rust-toolchain.toml`, are file nodes tagged `npm-manifest`, `python-manifest` or `cargo-manifest`.
- **Configuration version 3.** `.balk2.json` accepts `"version": 2` or `"version": 3`. The published schema reads both.
- **`analyzeFile` is deprecated** on `JsTsAnalyzer`, `PythonAnalyzer` and `RustAnalyzer`. Use `generateConnectionMap` for a repository. `analyzeFile` remains for single files.
- **Python output changes.** Every removed edge is a false positive, and every new edge has a fixture or a unit test. The full list is in `docs/v3/python-changes.md`.

### Added

- **Rust.** Rust is analyzed by a front end of the same kind as Python and JS/TS: crates and Cargo packages, the module tree, names, traits and `impl` blocks, macros, compile-time includes, build scripts and `libloading` observations. Module edges are checked against `rustc` dependency files.
- **Python.** Python is analyzed with a real tokenizer and parser. Module edges are checked against CPython's `ast` and `importlib`.
- **JS/TS.** `references` for type positions that name a repository type, and state edges for module-level state.
- **Process execution.** `package.json` scripts, Makefile recipes, `[project.scripts]` entries, and literal process calls in JS/TS, Python and Rust create `executes` edges.
- **Cross-language boundaries.** WASM, PyO3, napi-rs, attribute registrations and process execution connect two languages only when both sides provide evidence.
- **Scanning.** `include` accepts either the v2 array of globs or an object `{ patterns, tests }`; `tests` defaults to true, and test files are tagged. `target/` (with a `Cargo.toml` beside it), `.venv/` and `venv/` (with a `pyvenv.cfg`), and `node_modules/` are never scanned. Lock files are not scanned.

- **Package nodes.** Every named `package.json`, every Cargo target and every `pyproject.toml` project is a `package` node in `connection-map.json`. A repository whose `package.json` files are in `include` gains these nodes, a `packageRoot` edge from each package to its entry files, and `dependsOn` edges between workspace packages. A `dependsOn` edge comes from an npm `workspace:` spec, or from a version range that the workspace package's version satisfies. Only the manifests in `include` are read, and an entry that points into an excluded directory such as `dist/` is neither a root nor a problem.
- **Repeated dependencies.** When a package declares the same dependency more than once, the map keeps the most production-relevant kind (normal, build, peer, optional, then dev). A `cfg` or `implicit` flag is kept only when every such declaration has it.
- **Entry points.** A Python `[project.scripts]` entry gets a `packageRoot` edge to its module. An entry point in a group gets a `registers` edge from a `registry:entry-points:<group>#<name>` key to its target.
- **uv workspace membership.** A `workspace = true` source must name a member of the enclosing `[tool.uv.workspace]`. A source to a project outside `members`, or inside `exclude`, draws no `dependsOn` edge and is reported as a `manifest` diagnostic.
- **Manifest diagnostics.** A manifest that cannot be read or parsed, a workspace glob that matches no package, a missing entry file and an unresolved entry point appear as `manifest` diagnostics in `generate` and `check`.

### Fixed

- `generate` keeps the existing `generatedAt` and commit when the sources have not changed. Before, every run rewrote both, so the pre-commit hook always reported a change.
- Manifest spans are correct on Windows checkouts, which use CRLF line endings.
- Rust generic associated types with a `where` clause, such as `type Item<'a> where Self: 'a;` in a trait, no longer report a syntax error.
- A `[project.scripts]` entry finds its module in the manifest's own directory, and its span points at the entry's own line.

### Known limits

- Items not covered by V3 are listed in `docs/v3/deferred.md`, with the reason and the phase that might reconsider each.
- Partial cells in the V3 column, and the limits behind them, are listed in `docs/v3/language-parity.md`. The Rust `libloading` cell (row 16) is Partial. The user approved it for 3.0.0.

### Upgrading

- Pre-commit: set the `rev` to `v3.0.0`. The hooks run `@lumenspero/balk2@3.0.0`.

## 2.0.1

- **Unknown `data` keys are reported.** A `.balk2.json` with a key the loader does not read in `data`, such as `data.extensions` from 1.x, now produces a warning, for example `data.extensions: unknown key ignored`. Map output is unchanged.
- **README configuration.** The configuration section starts from a minimal `.balk2.json` and documents each key. The previous example used one project's file names and was not valid JSON.

## 2.0.0

### Breaking changes

- **Connection map version 2.** `connection-map.json` now has `version: 2` and six new tables: `eventChannels`, `registryKeys`, `metadataKeys`, `resources`, `statePaths` and `unresolved`. The exported `ConnectionMap` type has these tables, so TypeScript code that reads the map must handle them. `ConnectionMapV1` is exported for code that still handles the old shape.
- **Older maps are reported as out of date.** `deserializeConnectionMap` still reads version 1 maps and version 2 maps written with reverse links. `balk2 check` reports them as out of date until they are regenerated.
- **`data.extensions` in `.balk2.json` was removed.** The loader never read it. The published schema rejects it.

### Changes to output

- **Data artifact detection is stricter.** A literal counts as a data file only when it has a basename and a data extension. URLs, web-root paths such as `/manifest.json`, and templates with placeholders such as `{page}` are no longer recorded. Literals that are searched or compared, such as `name.endsWith('.json')`, are not accesses.
- **Path pieces are joined.** `path.join(root, 'data', 'x.json')` and pathlib or `os.path.join` calls in Python are recorded once as `data/x.json`. The bare `x.json` node is no longer recorded for those calls. A lone trailing piece is still recorded as written.
- **Direction is more precise.** `open(path)` with no mode is a read. Write mode, and names such as `output_dir` or `out_file`, mark writes; a name-only hint is recorded at low confidence.
- **Python defaults on `def` lines are analyzed.** Previously, a path given as a default argument on a `def` line was skipped.
- **Attributes that hold a directory are resolved.** In Python, `self.output_dir = Path(output_dir)` with a literal default lets `self.output_dir / "x.json"` resolve to the full path.

### Query and traversal

- **New `balk2 query` command.** Prints relationships around a file or node, with filters for family, confidence, node kind, depth and limit. See the README for the options.
- **Focused queries follow code edges by default.** Other families are listed for each node reached but not expanded. Use `--traverse` to follow more.
- **Hubs are not expanded.** A node with more than 50 relationships is listed but not expanded, in queries and in Connection Paths. The focus itself is always expanded. Use `--max-degree` or `--no-max-degree` to change this in queries.
- **Default confidence is `medium`.** Low-confidence direction guesses are hidden unless `--min-confidence low` is given.

### Diagnostics and CI

- **`--fail-on <kinds>`** on `generate` and `check` exits `1` when a selected diagnostic is found: `syntax`, `config`, or an unresolved reason such as `ambiguous-global`. Outputs are still written. Unknown kinds exit `2`.
- **Diagnostics are deterministic.** They are sorted by path, line, column, kind and message, independent of locale.
- **The programmatic API returns diagnostics.** `generateConnectionMap` and `checkConnectionMap` include a `diagnostics` array.

### Configuration

- **`.balk2.json` sections are validated by a published schema.** The schema ships at `dist/balk2.schema.json`. Reference it with `"$schema"` for editor completion.
- **Clarified `--output`.** The option accepts a directory, or a `.json` or `.md` file path. This is a documentation change; the behavior is unchanged.

### Package entry points

- **One supported entry point.** `@lumenspero/balk2` has ESM and CommonJS builds, each with TypeScript declarations. Deep imports such as `@lumenspero/balk2/dist/...` are not supported.
- **Supported API.** The names exported from the package root are the public API. Anything else is internal and may change in any release.
- **Supported CLI.** The `balk2` command is the supported command-line interface.
- **Editor schema.** `dist/balk2.schema.json` is for editor validation through `"$schema"`, not for imports.

### Migration

1. Remove `data.extensions` from `.balk2.json`, if present.
2. Run `balk2` to regenerate `connection-map.json` and `connection-map.md`. Until you do, `balk2 check` reports the map as out of date.
3. If CI runs `balk2 check`, expect one failure on the first run after upgrading. Regenerate the map and commit it.
4. If your code reads `ConnectionMap` directly, handle the six new tables. Use `ConnectionMapV1` for code that still expects the old shape.
5. If you want CI to stop on new problems, add `--fail-on` with the kinds you care about, such as `syntax,config`.

### Known limits

- Connection Paths in the Markdown output show only indirect chains through shared artifacts, event channels and registry keys. Direct structural edges are shown in the File Connections section.
- **Events.** A class that emits to itself is not connected when its emitter is heard through an instance variable. An emitter passed to a function as a parameter is not followed. A shared emitter reached through a factory function is not connected; each call is reported instead.
- **Module loads.** A loader called through an alias of a configured object is not matched to its receiver.
- **Registries.** Element reads such as `routes[name]` are not lookups yet. A lookup through a parameter is not joined to the registry passed in.
- **Shared state.** A write through a passed-in state object is not traced. Only `const` aliases are followed, so `let` bindings are not. A reference held in an object literal is not traced to its property.
