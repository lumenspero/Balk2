# Packages

This is the reference for package discovery in V3: what each ecosystem contributes to the connection
map, the rules that decide it, and the data that is kept for later phases. It is written for the
people who change the discovery code and the phases that consume it. The map format itself is in
`connection-map-schema.md`.

## Package nodes

A `package` node is one distribution or build unit. Its id is `package:<ecosystem>:<dir>`, with
`#<target>:<name>` added when the node is one target of a package (`lib`, `script`, `bin`, `example`,
`test`, `bench`, `build`).

| Ecosystem | Manifest                                  | Nodes                                                                        |
| --------- | ----------------------------------------- | ---------------------------------------------------------------------------- |
| npm       | `package.json` with a `name`              | One node per named package. Roots come from `main`, `bin` and `exports`.     |
| Python    | `pyproject.toml`, `setup.cfg`, `setup.py` | One `lib` node per project, one `script` node per `[project.scripts]` entry. |
| Cargo     | `Cargo.toml`                              | One node per target, after Cargo's auto-discovery rules.                     |

## Edges

- **`packageRoot`** (package to file): an entry file. Cargo and npm roots come from discovery. Python
  script roots come from entry-point resolution in the Python front end, where the module index exists.
- **`dependsOn`** (package to package): an internal dependency. `metadata.kind` is the most
  production-relevant kind the pair declares: normal, build, peer, optional, then dev. `cfg` and
  `implicit` are kept only when every declaration of that kind agrees.
- **`registers`** (registry key to target): a Python entry point in a group. The key is
  `registry:entry-points:<group>#<name>`, with repository-wide scope.

## Discovery rules

- **Scope.** Only files that pass the configured `include` and `exclude` are read. A repository whose
  root `package.json` is outside `include` has no npm packages from that file.
- **Unscanned entries.** The scan skips directories such as `dist/`. An entry that exists on disk but
  was not scanned is neither a root nor a problem. An entry missing from both the scan and disk is a
  `manifest` problem.
- **Unreadable manifests.** A manifest that cannot be read is a `manifest` problem, and it is left out
  of discovery so it does not also report a parse error.
- **Problems.** Every discovery problem is a `manifest` diagnostic in `generate` and `check`.

## Cargo extern table

Cargo dependencies that are not packages in the repository are kept as an extern table, so later
name resolution can tell them apart from unresolved names.

- **What it holds.** One `CargoExtern` per dependency: the manifest that declares it, the name code
  uses (the table key with `-` changed to `_`), the kind, and the source (`registry`, `git`, or
  `path` for a path outside the repository).
- **Where it is produced.** `discoverCargoPackages` returns it as `externs`.
- **Where it is carried.** `discoverRepositoryPackages` returns it as `externs` on
  `RepositoryPackages`, the result of step 2 in `buildConnectionGraphDetailed`.
- **Who reads it.** The Rust name resolver, in Phase 9.2. A first path segment that names an extern
  crate (`use serde::...`) resolves through this table, and is external rather than unresolved.
- **Not in the map.** The table is not written to `connection-map.json`. The map has no table for it.
  Adding one is a schema change, and it belongs with the resolver work.

## Workspace membership

- **npm.** A `workspaces` glob selects the packages a root owns. `!` removes matches. A dependency
  links to a workspace package only through the `workspace:` protocol or a satisfied version range.
- **Cargo.** A `[workspace]` `members` glob selects a package's workspace root. `exclude` removes
  matches. A package that is not a member of the workspace above it is a `manifest` problem.
- **Python (uv).** A `workspace = true` source must name a member of the nearest enclosing
  `[tool.uv.workspace]`, selected by `members` and not by `exclude`. A source to a non-member draws no
  edge and is a `manifest` problem. A project with no enclosing uv workspace keeps the edge.

## Known limits

- A `dependsOn` edge carries one kind per package pair. The pair keeps the most production-relevant kind.
- Import roots for Python come from `python.roots` in `.balk2.json`. Manifest-declared roots are not
  yet read (Phase 4.2).
- An export pattern that matches nothing is not reported when its directory exists on disk, because the
  scan may have skipped the directory.
