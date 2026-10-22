# Session Delta: Phase 7 Complete

**Range:** `7093c74` (6.5 complete) to `c2ea8d2` (python membership update).
**Status:** Phase 7 is complete. Items 7.1 through 7.5 are implemented, and the exit criterion is met. The phase verify command, `npx vitest run src/analyzer/rust/cargo src/packages`, passes.

## Commits

| Commit    | Subject                                     | Files | Lines (+/-) | Notes                                                               |
| --------- | ------------------------------------------- | ----- | ----------- | ------------------------------------------------------------------- |
| `e76ecc9` | 7.1 complete                                | 2     | +740 / 0    | Cargo manifest parsing.                                             |
| `6ff6e1c` | 7.2 complete                                | 43    | +881 / -3   | Targets, auto-discovery, workspace member globs, virtual manifests. |
| `ee3f13a` | 7.3 complete                                | 4     | +421 / -3   | `dependsOn` edges, extern table, implicit lib edges.                |
| `3031687` | 7.4 complete                                | 12    | +230 / -4   | `manifest` problems for Cargo.                                      |
| `cb48bf8` | 7.5 complete                                | 19    | +881 / -31  | npm package discovery.                                              |
| `3803737` | package discovery for python/rust           | 17    | +361 / -17  | Wires Cargo, npm and Python discovery into the build pipeline.      |
| `08948f1` | unreadable manifests, repeated dependencies | 4     | +132 / -36  | Read failures become problems. One `dependsOn` edge per pair.       |
| `fa0290d` | cargo externs and uv workspace updates      | 9     | +58 / 0     | Extern table carried on the result. uv workspace fixture.           |
| `c2ea8d2` | python membership update                    | 5     | +193 / -2   | uv `workspace = true` sources must name a member.                   |

## What Phase 7 built

- **Cargo** (`src/analyzer/rust/cargo/`): manifest parsing (`manifest.ts`), targets (`targets.ts`), workspace member globs (`workspace-members.ts`), packages and roots (`packages.ts`), dependencies and externs (`dependencies.ts`).
- **npm** (`src/packages/npm-packages.ts`, `npm-range.ts`): one node per named `package.json`, entries from `main`, `bin` and `exports`, `dependsOn` through `workspace:` and satisfied ranges.
- **Shared** (`src/packages/`): `glob.ts`, `paths.ts`, `repository-packages.ts`, which combines the three ecosystems for the pipeline.
- **Python** (`src/analyzer/python/project/python-packages.ts`): uv `workspace = true` membership check. Entry points and roots were already in place from Phase 4.
- **Pipeline** (`src/cli/build-graph.ts`, `src/analyzer/python-front-end.ts`): step 2 adds package nodes, `packageRoot` and `dependsOn` edges. The Python front end resolves entry points, which adds `packageRoot` and `registers` edges. `generate` and `check` report `manifest` diagnostics.
- **Fixtures** (`test/fixtures/`): `cargo-single`, `cargo-virtual-workspace`, `cargo-renames`, `cargo-custom-bin`, `cargo-proc-macro`, `cargo-build-script`, `cargo-missing-paths`, `npm-workspaces`, `python-packages`, `python-workspace`.
- **Docs**: `docs/v3/packages.md` (new), `docs/v3/python-changes.md`, `CHANGELOG.md` (Unreleased).

## Decisions

1. **One package node per Cargo target, one per npm package, one `lib` per Python project, one `script` per Python script.** Cargo target ids and Python script ids carry the target name (`#bin:<name>`, `#script:<name>`). npm ids and Python `lib` ids do not.
2. **Cargo membership is checked only for a package.** A virtual or unparseable manifest inside a workspace is not reported as a non-member. This came from a bug fixed in 7.4.
3. **npm nodes are emitted for every named `package.json`, root included.** A root with no `name` only defines its workspace.
4. **An npm entry is a problem only when it is missing from both the scan and disk.** The scan skips `dist/`, so built entries are not reported.
5. **Entry-point registry keys use repository-wide scope (`.`).** The scope is part of the key id.
6. **One `dependsOn` edge per package pair.** The kind is the most production-relevant one (normal, build, peer, optional, dev). `cfg` and `implicit` are kept only when every declaration agrees.
7. **Manifests are read only from `include`.** The repo's own `package.json` is outside it, so the repo's own map is unchanged by this phase.
8. **Python `workspace = true` sources must name a member of the enclosing uv workspace.** A project with no enclosing workspace keeps its edge.
9. **The Cargo extern table is carried but not written to the map.** Phase 9.2 reads it. Adding a map table would be a schema change.

## Bugs found and fixed in this phase

- **Virtual-manifest false positive (7.4).** A membership problem fired for manifests with no `[package]`. Fixed by gating on `manifest.package`.
- **Expanded objects after a wrong-width format run (7.2).** A prettier run with the default width expanded objects in scratch. Fixed by restoring the canonical files and re-appending the new blocks.
- **Built entries reported missing (wiring).** Fixed with the `exists` check in decision 4.
- **Silent loss of metadata.** Repeated dependencies dropped `kind`, and `cfg` could be dropped without notice. Fixed in `08948f1` with the merge rule in decision 6.
- **Unreadable manifests were read as empty.** An unreadable `Cargo.toml` vanished silently. Fixed in `08948f1` with a `manifest cannot be read` problem.

## Verification at `c2ea8d2`

- Typecheck, lint, format:check, and `test:package` pass.
- Full vitest suite, three shards: 1,995 passed, 8 skipped.
- No committed snapshot changed. `python-baseline.txt` is unchanged.

## Open items

- **Phase 9.2:** the Rust name resolver reads the extern table. Nothing reads it yet.
- **Phase 4.2:** Python import roots from manifests. The current code uses `python.roots` from `.balk2.json`.
- **Phase 15.1:** the Markdown `## Packages` section. Deferred by decision.
- **Git history label collision:** V2-era commits such as `c804928` ("7.7 complete, phase 7 complete") and `ecf750a` ("7.6 complete") reuse the V3 phase labels. The V3 Phase 7 commits are `e76ecc9` through `cb48bf8`. The older commits are not modified.
- **Connection map:** `connection-map.json` in this repo has no packages, because its root `package.json` is outside `include`. It needs no regeneration for this phase.
- **Export patterns:** a pattern under a directory that exists on disk is not reported, even when it matches nothing.

## Next

Phase 8, the Rust module tree.
