# Changelog

## 2.0.0 (unreleased)

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
