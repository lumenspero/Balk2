# Balk2 V2 Phase 0 Contract

## Product Outcome

Balk2 generates `connection-map.md` and `connection-map.json` for a repository. The artifacts accompany an implementation plan and give an AI coding agent the relevant structural and indirect connections needed to make accurate, multi-file edits efficiently.

The map is change context, not an architecture report or a substitute for reading source.

## Current Package Snapshot

Observed from the 1.0.5 repository state:

- Package name: `@lumenspero/balk2`.
- Runtime package mode: ESM (`"type": "module"`).
- Root runtime entry: `dist/index.js`.
- Root declaration entry: `dist/index.d.ts`.
- CLI binary: `balk2` -> `dist/cli.js`.
- Build target: ESM only.
- No `exports` map is present.
- The CLI's `--version` output is hard-coded as `v0.1.0`, which does not match the package version.

The package includes only `dist` in its published files, so every supported consumer scenario must be tested from an `npm pack` tarball, not by importing source files from this checkout.

## V2 Public Package Contract

Phase 1 will implement the following contract.

| Concern              | V2 contract                                                                         |
| -------------------- | ----------------------------------------------------------------------------------- |
| Package root         | `@lumenspero/balk2` is the only supported programmatic import path.                 |
| Runtime modules      | Ship ESM and CommonJS builds, selected through conditional package exports.         |
| Type declarations    | The root entry provides declarations matching both runtime builds.                  |
| CLI                  | `balk2` is a package binary, not a supported programmatic import path.              |
| Deep imports         | `dist/*` and source-module deep imports are unsupported.                            |
| Node support         | Node.js 18 and later.                                                               |
| TypeScript consumers | Node16, NodeNext, and Bundler module resolution must resolve the root declarations. |
| Version reporting    | `balk2 --version` reports the installed package version.                            |

This contract intentionally favors a narrow, stable public API. New subpath exports require documentation and packed-package tests before release.

## Root API Inventory

The current root entry point exports these public groups. Phase 1 package tests must prove that each value export can be imported at runtime and each type export can be resolved by TypeScript.

| Group              | Public exports                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Graph              | `ConnectionGraph`, `normalizePath`                                                                                                                                                                                                 |
| Serialization      | `serializeConnectionMap`, `deserializeConnectionMap`                                                                                                                                                                               |
| Analyzers          | `JsTsAnalyzer`, `PythonAnalyzer`, `resolveImportPath`, `Analyzer`, `AnalyzerOptions`                                                                                                                                               |
| Data               | `SUPPORTED_DATA_EXTENSIONS`, `detectArtifactFormat`, `isDataArtifact`, `registerDataArtifacts`, `inferDataRelationshipType`, `addDataRelationship`, `DataReference`                                                                |
| Rendering          | `renderMarkdown`, `findConnectionPaths`, `MarkdownOptions`, `PathFinderOptions`, `FormattedPath`                                                                                                                                   |
| Generation and Git | `generateConnectionMap`, `installGitHook`, `uninstallGitHook`, `checkConnectionMap`, `getGitCommitHash`, `isGitRepository`, `GenerateOptions`, `GenerateResult`, `HookResult`, `CheckOptions`, `CheckResult`                       |
| Configuration      | `loadBalk2Config`, `applyExplicitLineage`, `filterFilesWithConfig`, `matchPattern`, `Balk2Config`, `DataConfig`, `DataLineageEntry`                                                                                                |
| Graph types        | `NodeKind`, `FileNode`, `SymbolNode`, `SymbolType`, `ArtifactNode`, `ArtifactFormat`, `GraphNode`, `CodeRelationship`, `DataRelationship`, `RelationshipType`, `Confidence`, `Relationship`, `RepositoryMetadata`, `ConnectionMap` |

## Connection-Map Schema Contract

V1 remains readable by V2 tooling. V2 will publish a new schema version rather than mutating the meaning of V1 fields.

- Version 1 is the existing `files`, `symbols`, `artifacts`, and `relationships` shape.
- Version 2 adds mechanism-specific virtual nodes and relationship metadata.
- V2 readers either load both versions directly or use a documented V1-to-V2 conversion.
- Every relationship emitted by V2 has a confidence level and evidence source.
- Reverse views are derived by readers/renderers instead of persisted as duplicate relationship facts.
- JSON and Markdown output remain deterministic for identical input, configuration, and generation metadata.

## Analysis Boundaries

The analyzer emits a high-confidence edge only when it can establish a binding, static value, or explicit configured relationship.

- Local scope and module resolution take precedence over global-name lookup.
- Matching event names do not connect systems unless their emitter/receiver identities are compatible.
- Matching registry keys do not connect systems unless their registry identities are compatible.
- Dynamic values, duplicate global candidates, unresolved imports, and unsupported language constructs become diagnostics or explicit annotations, not guessed edges.
- Project-specific behavior is added through versioned `.balk2.json` protocol configuration rather than framework-specific analyzer branches.

## Fixture and Accuracy Baseline

The fixture catalog is maintained in `test/fixtures/v2/fixture-catalog.json`. Each fixture records its intended relationship family, expected facts, and negative cases.

The release gate measures:

- Expected-edge recall: all declared high-confidence fixture edges are present.
- False positives: no declared negative edge is emitted.
- Determinism: normalized JSON and Markdown are identical across repeated runs.
- Diagnostics: every intentionally dynamic or ambiguous fixture produces its expected diagnostic category.
- Package compatibility: the packed tarball passes ESM runtime import, CommonJS runtime require, TypeScript declaration, CLI, and package-content checks.

## Phase 1 Entry Criteria

Phase 1 may begin once this contract is accepted. Its first implementation tasks are to update the build outputs and manifest to satisfy the public package contract, then add packed-tarball consumer tests for the root API and CLI.
