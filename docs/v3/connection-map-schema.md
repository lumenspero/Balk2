# Connection map schema, version 3 (draft)

Status: **Draft, frozen at the end of Phase 0.** Field names here are authoritative. A change after Phase 0 requires updating this document and the affected tests in the same change.

This document describes only what V3 adds or changes. Everything in `docs/v2/connection-map-schema.md` still applies unless stated here.

## Top level

```json
{
  "version": 3,
  "repository": { "commit": "…", "generatedAt": "…" },
  "files": {},
  "packages": {},
  "symbols": {},
  "artifacts": {},
  "eventChannels": {},
  "registryKeys": {},
  "metadataKeys": {},
  "resources": {},
  "statePaths": {},
  "unresolved": {},
  "relationships": []
}
```

Changes from v2:

- `version` is `3`.
- `packages` is new. It is empty for repositories with no manifests.
- Every other table keeps its v2 meaning. Entries may gain fields, listed below.

## Nodes

### `files`

Each file has `language`, one of:

| Value                      | Meaning                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `javascript`, `typescript` | JS and TS source, including `.jsx`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`.                                              |
| `python`                   | `.py` and `.pyi`.                                                                                                        |
| `rust`                     | `.rs`.                                                                                                                   |
| `npm-manifest`             | `package.json`, and `tsconfig*.json` for JS/TS projects.                                                                 |
| `python-manifest`          | `pyproject.toml`, `setup.cfg`, `setup.py`.                                                                               |
| `cargo-manifest`           | `Cargo.toml`, plus Rust tool configuration (`rust-toolchain.toml`, `rustfmt.toml`, `clippy.toml`, `.cargo/config.toml`). |

Manifests are files, not artifacts. A v2 map that recorded `pyproject.toml` or `Cargo.toml` as an artifact is read with those entries moved to `files`. See "Reading older maps".

A file may also carry `tests: true` when D5 tags it as test code.

### `packages` (new)

```json
{
  "id": "package:cargo:crates/ingest#bin:ingest",
  "kind": "package",
  "ecosystem": "cargo",
  "name": "ingest",
  "target": "bin",
  "manifest": "crates/ingest/Cargo.toml",
  "roots": ["crates/ingest/src/main.rs"],
  "edition": "2021"
}
```

| Field       | Type                               | Notes                                                                                                                                                                                                                      |
| ----------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | string                             | `package:<ecosystem>:<manifest dir>` or `package:<ecosystem>:<manifest dir>#<target>:<name>`.                                                                                                                              |
| `kind`      | `"package"`                        | Constant.                                                                                                                                                                                                                  |
| `ecosystem` | `"npm"` \| `"python"` \| `"cargo"` |                                                                                                                                                                                                                            |
| `name`      | string                             | Distribution name (npm, Python), or crate name as used in code (Cargo).                                                                                                                                                    |
| `target`    | string, optional                   | Cargo targets: `lib`, `bin`, `test`, `example`, `bench`, `build-script`, `proc-macro`. Python: `lib`, or `script` for each `[project.scripts]` entry. npm: `lib` or `bin`. Absent when a manifest has one implicit target. |
| `manifest`  | string                             | Repository-relative path of the manifest file.                                                                                                                                                                             |
| `roots`     | string[]                           | Entry files: crate roots, npm entry points, Python import roots.                                                                                                                                                           |
| `edition`   | string, optional                   | Cargo edition.                                                                                                                                                                                                             |

### `symbols`

`SymbolType` gains these values:

| Value    | Used by                                                                                      |
| -------- | -------------------------------------------------------------------------------------------- |
| `struct` | Rust `struct`, and a Rust `union` (with `metadata.rustKind: "union"`).                       |
| `enum`   | Rust `enum`, JS/TS `enum`. Python `Enum` subclasses stay `class` with `metadata.enum: true`. |
| `trait`  | Rust `trait`.                                                                                |
| `module` | Rust inline `mod x { }`, TS `namespace`. Rust file modules are file nodes, not symbols.      |
| `macro`  | Rust `macro_rules!`.                                                                         |

Existing values keep their meaning. Rust `type` aliases are `type`. Rust `const` is `constant`. Rust `static` is `variable`.

Symbol ids follow the naming table in the plan. Summary: `<file>:<name>`, `<file>:<Outer.Inner>`, `<file>:<Type>.<method>`, and `<file>:<Type>[<Trait>].<method>` for Rust trait impls.

### `artifacts`

`ArtifactFormat` is unchanged. Manifests no longer appear here.

### Virtual nodes

`eventChannels`, `registryKeys`, `metadataKeys`, `resources`, `statePaths` and `unresolved` keep their v2 shapes, with these additions:

- `statePaths`: `StateRootKind` gains `module`, for a module-level binding treated as state under D8. Its root id is `<file>:<name>`.
- `registryKeys`: a key registered through a Rust attribute or a Python decorator uses the same id form as a configured registry, `registry:<scope>#<key>`.
- `eventChannels`: unchanged. Rust does not create name-keyed channels.

## Relationships

Each relationship keeps `type`, `from`, `to`, `confidence`, `evidence`, `spans` and optional `metadata` from v2.

### New relationship types

| Type             | From → to                | Family | Notes                                                                                            |
| ---------------- | ------------------------ | ------ | ------------------------------------------------------------------------------------------------ |
| `declaresModule` | parent file → child file | code   | Rust `mod foo;`. Python has no equivalent, since its packages are not declared.                  |
| `dependsOn`      | package → package        | code   | Internal dependencies. `metadata.kind`: `normal`, `dev`, `build`, `optional`, or `build-output`. |
| `packageRoot`    | package → file           | code   | The package's entry or crate root.                                                               |
| `executes`       | owner → file             | code   | A literal command that runs a repository script.                                                 |

`declaresModule`, `dependsOn`, `packageRoot` and `executes` belong to the `code` family in `query`.

### Changed relationship semantics

- `exports`: from a file to an exported symbol. Re-exports (D9, pending confirmation) add one `exports` edge for each re-exported name, in addition to the file-level `imports` edge.
- `imports`: `metadata.typeOnly: true` marks type-only imports. Python `if TYPE_CHECKING:` imports and Rust type-only uses are marked the same way.
- `imports`: `metadata.loadKind` gains `include-macro`, `dunder-import`, `spec-from-file`, `run-path`, and `wasm-bindgen-module`.

### Evidence

`Evidence` gains `manifest`, for facts read from `package.json`, `pyproject.toml`, `setup.cfg` or `Cargo.toml`.

| Value        | Meaning                                                               |
| ------------ | --------------------------------------------------------------------- |
| `ast`        | Syntax tree (Python, Rust, and JS/TS without a checker).              |
| `ts-program` | TypeScript program and checker.                                       |
| `config`     | `.balk2.json` or a source annotation.                                 |
| `manifest`   | A package manifest.                                                   |
| `heuristic`  | A name or convention, not a binding. Such edges are `low` confidence. |

## Unresolved reasons

`UnresolvedReason` gains:

| Reason                   | Meaning                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `unresolved-module-path` | An internal-looking import or path that cannot be resolved, in any language.                                                       |
| `macro-generated-item`   | A path to a name that an item-level macro call in its module may generate (Rust). Not a miss: the analyzer does not expand macros. |
| `ambiguous-star-import`  | A name supplied by more than one star or glob import (Python `*`, Rust glob).                                                      |
| `dynamic-include-path`   | An include path built from `concat!`, `env!` or a non-literal expression.                                                          |
| `unresolved-binding`     | A cross-language consumer naming something its producer does not export.                                                           |

## Diagnostics

Diagnostic kinds usable with `--fail-on` gain:

| Kind                 | Meaning                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `manifest`           | A package manifest that cannot be parsed, or names a missing path. |
| `unreachable-module` | A Rust file no crate root reaches.                                 |
| `module-conflict`    | Rust has both `foo.rs` and `foo/mod.rs`.                           |
| `shadowed-module`    | Python `pkg/x.py` is hidden by the package `pkg/x/`.               |

`syntax` is now reported for Python and Rust, as well as JS/TS.

## Determinism

Ordering rules from v2 still apply. The new tables are sorted by id. Relationships are sorted by `(type, from, to)`. Package ids sort lexically by their string form.

## Reading older maps

`deserializeConnectionMap` accepts versions 1, 2 and 3.

- **Version 2 → 3.** `packages` starts empty. Files whose path is a manifest (`pyproject.toml`, `Cargo.toml`, `package.json`) that were stored as artifacts are moved to `files` with the matching `*-manifest` language. Their artifact entries are removed. Everything else is unchanged.
- **Version 1 → 3.** Converted through version 2, as in v2.
- **Version 3 maps written before any new table existed.** Missing tables read as empty.
- `balk2 check` reports version 1 and 2 maps as out of date until they are regenerated. This matches v2 behavior.
- Any other version is rejected with `Unsupported connection map version`.

## Compatibility

For TypeScript consumers, V3 is breaking, as V2 was.

- `ConnectionMap` gains `packages`.
- Exhaustive `switch` statements over `NodeKind`, `SymbolType`, `RelationshipType`, `Evidence`, `LoadKind`, `StateRootKind`, `UnresolvedReason` and the diagnostic kinds must handle the new values.
- `ConnectionMapV2` is exported for code that reads the previous shape.
- Runtime consumers of JSON see the new tables and fields, but existing fields keep their names and meanings.

## Fixtures for schema tests

- A v2 map written by 2.0.1 reads under v3 with the manifest move applied.
- A v3 map round-trips through `serializeConnectionMap` and `deserializeConnectionMap` unchanged.
- Every new union value appears in at least one fixture or in a test that constructs it directly.
