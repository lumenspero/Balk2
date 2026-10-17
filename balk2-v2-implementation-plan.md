# Balk2 V2 - Connection Map and Package Surface Plan

## Purpose

V2 makes Balk2 reliable in the two places where consumers need it most:

1. As an installed npm package with explicit, tested import and export entry points.
2. As a repository-wide connection mapper that can find relationships hidden behind globals, events, registries, shared state, and ordinary module boundaries.

The goal is a framework-agnostic solution. V2 must not encode a special case for a particular engine or library. Instead, it provides semantic analysis plus configurable protocol definitions that describe a repository's event, registry, and state conventions when static inference alone is insufficient.

## Findings From V1

The existing implementation plan establishes a strong graph-first direction: a canonical JSON graph, deterministic Markdown, typed relationships, code symbols, data artifacts, and language-specific analyzers. The delivered code has the same basic shape.

There are two material gaps to address:

- `JsTsAnalyzer` analyzes each file independently. Its `importsMap` and `topLevelSymbols` are local to one invocation, so it cannot resolve a non-imported global symbol from another source file.
- The published manifest exposes `main`, `module`, and `types`, but has no `exports` map and builds only ESM. The root source API is broad, yet there is no packed-package import matrix proving ESM, CommonJS (if supported), declaration resolution, CLI execution, or intended subpath imports.

The first gap limits connection-map accuracy. The second makes an otherwise usable API fragile for package consumers. V2 treats both as shipped-product requirements.

## V2 Design Principles

- Prefer binding-aware facts over name matching. An edge should be emitted from a resolved declaration, not merely because two identifiers share text.
- Preserve uncertainty. Every inferred edge records a confidence level, its evidence, and source locations when available.
- Make indirect mechanisms visible without pretending they are direct calls. Events, state, and registry keys use their own virtual nodes and relationship types.
- Keep the graph deterministic. Ordering, IDs, and serialized output must be stable for identical source and configuration.
- Make conventions configurable, not framework-specific. Built-in signatures are conservative defaults; configuration extends them with receiver, method, argument, and direction rules.
- Degrade gracefully. Dynamic or ambiguous code should yield an unresolved observation or a configurable diagnostic, never a misleading high-confidence edge.

## Target Graph Model

Keep V1 file, symbol, and data artifact nodes. Add the following node families in schema version 2:

- `event-channel`: a normalized event name, optionally scoped by a resolved emitter/receiver identity.
- `registry-key`: a string key scoped to a resolved registry identity.
- `state-path`: a shared root plus a static property path, such as `globalThis.store.session.user`.
- `external-module`: an installed package or Node built-in when it cannot be mapped to a repository file.
- `unresolved-reference`: an optional, diagnostic-only node for dynamic or ambiguous relationships.

Add relationship types that retain the mechanism:

- Module and symbol: `imports`, `exports`, `reExports`, `calls`, `constructs`, `references`, `extends`, `implements`.
- Events: `emits`, `subscribes`, `unsubscribes`, `dispatches`.
- Registries: `registers`, `resolves`, `routesTo`.
- Shared state: `readsState`, `writesState`, `deletesState`.
- Existing data lineage relationships remain unchanged.

Each relationship should support `confidence`, `evidence` (for example, `ast`, `ts-program`, `config`, or `heuristic`), and one or more source spans. Reverse links are derived at render/query time rather than stored as duplicate facts. This prevents divergent pairs such as `imports` and `importedBy`.

## Phase 0 - Contracts, Inventory, and Compatibility Baseline

Create explicit contracts before changing analysis behavior.

- Publish a graph schema document and a migration policy. Version 1 readers either remain supported or receive an explicit conversion path to version 2.
- Inventory every public export from `src/index.ts`, every documented import example, CLI command, configuration field, and generated artifact.
- Define supported Node versions, ESM/CommonJS policy, and supported TypeScript module-resolution modes.
- Capture representative fixtures for ESM, CommonJS, TypeScript path aliases, barrel re-exports, globals, events, registries, state, Python/JS data pipelines, and intentionally unresolved dynamic cases.
- Establish accuracy metrics per relationship family: expected edges found, false-positive budget, unresolved observations, and fixture runtime.

Exit criterion: the public API, graph schema, and supported runtime matrix are written down and covered by a baseline fixture suite.

## Phase 1 - Repair the npm Import and Export Surface

Make the installed tarball, rather than the repository checkout, the release artifact under test.

- Add an explicit `exports` map for the root API and intentional subpaths only. Every entry must provide `types` and runtime conditions that correspond to files actually produced in `dist`.
- Decide and document the module policy. Recommended default: ship dual ESM and CommonJS artifacts for a general developer tool, with conditional `import` and `require` entries. If CommonJS is intentionally unsupported, omit a `require` condition and make that break explicit as a major-version policy.
- Align `main`, `module`, `types`, `bin`, `files`, declaration files, and source maps with the selected policy. Do not advertise undocumented deep imports.
- Build the CLI as a tested executable with an appropriate Node shebang and run it from the packed package.
- Add package smoke tests that run `npm pack`, install the tarball into temporary ESM and CommonJS fixture projects, execute runtime imports, compile TypeScript consumers, invoke the CLI, and verify allowed subpaths.
- Verify package contents for omitted runtime dependencies, accidental source/test files, and missing declaration or executable files.
- Update the README with supported installation, import styles, module policy, and stable API entry points.

Exit criterion: a clean consumer can install the tarball and use every documented API and CLI path on every supported runtime mode.

## Phase 2 - Repository Program Model and Standard Module Resolution

Replace the per-file-only orchestration with a repository analysis session shared by all analyzers.

- Parse all supported JS/TS files once and retain source files, diagnostics, normalized paths, and source spans in a repository index.
- Build a TypeScript `Program` and `TypeChecker` when project configuration is available. Use compiler module resolution for `tsconfig` paths, `baseUrl`, package `exports`, declaration files, `.mts`/`.cts`, and Node resolution behavior.
- Retain a conservative syntax-only fallback for plain JavaScript projects without a usable `tsconfig`.
- Resolve ESM imports, CommonJS `require`, static `import()`, export declarations, `export *`, renamed exports, default exports, namespace imports, and barrels.
- Model internal module edges separately from external package edges. A missing internal target is an unresolved diagnostic, not an invented file node.
- Index declarations by stable symbol identity and scope, including top-level declarations, exports, class members, namespaces, and ambient declarations.

Exit criterion: the fixture suite resolves internal imports and re-exports using the same semantics a consumer's compiler/runtime expects, with explicit diagnostics for unresolved cases.

## Phase 3 - Global Symbol Traversal

Implement the requested two-pass global traversal on top of the repository program model.

### Collection pass

- Collect top-level functions, classes, variables, enums, namespaces, and explicitly declared ambient globals.
- Detect explicit assignments to configured global roots: `globalThis`, `window`, `self`, and `global`; capture static property paths such as `globalThis.App.Engine`.
- Record declaration scope, write location, exported status, origin file, and symbol identity. Do not make a plain top-level declaration global merely because it is top-level in an ES module.
- Resolve global aliases when they are statically established, such as `const root = globalThis`.

### Resolution pass

- Traverse identifier and property-access uses with lexical scope and TypeScript symbol resolution first.
- Only when a reference is genuinely unresolved in its local/module scope, consult the global index.
- Emit a direct `references` edge to the owning symbol and a file-level relationship only when the target is unambiguous.
- For duplicate global names, emit no direct edge unless configuration selects a target. Record an unresolved, low-confidence observation with candidate origins instead.
- Treat writes, reads, declarations, and deletes independently so later state analysis can reuse the facts.

Exit criterion: cross-file global references resolve accurately while locally shadowed identifiers and duplicate names do not create false connections.

## Phase 4 - Generalized PubSub and Event Channel Mapping

Map event-driven relationships through virtual event-channel nodes instead of collapsing them into calls.

- Provide a small conservative built-in protocol catalog for method names such as `on`, `once`, `off`, `addEventListener`, `removeEventListener`, `emit`, `dispatch`, and `dispatchEvent`.
- Describe every protocol with direction, event-name argument index, optional receiver identity rule, and payload argument index. Configuration can add project-specific method names and signatures without code changes.
- Resolve event names from string literals, no-substitution templates, locally constant bindings, and simple string concatenation only when each part is statically known.
- Scope an event channel by its resolved receiver when possible. `socket.emit('ready')` and `document.dispatchEvent(...)` should not automatically share one global `ready` channel.
- Support `new Event('name')`, `CustomEvent`, listener options, one-time listeners, and unsubscription as lifecycle metadata.
- Emit `emits`/`dispatches` from the calling symbol or file to the event channel, and `subscribes` from the listener owner to the same channel. Rendering can then show publishers and subscribers together.
- Label unknown receiver identities or dynamic names as unresolved observations instead of connecting every matching string across the repository.

Exit criterion: independent event systems are not conflated, while static publishers and subscribers become navigable through their shared channel node.

## Phase 5 - String-Based Factory, Registry, Router, and Plugin Tracing

Resolve string-key indirection through registry-key nodes and static registrations.

- Detect static object/dictionary registrations, `Map#set`, registry `register`/`add`/`set`, route declarations, decorators, and assignment patterns that associate a literal key with an identifier or class.
- Resolve the registry receiver identity and store each registration as `registry -> registry-key -> target symbol`.
- Detect lookup and creation calls such as `get`, `resolve`, `create`, `navigate`, `load`, and configured equivalents. Link callers to the appropriate registry-key with `resolves` or `routesTo`.
- Connect a resolved lookup key to the registered target only when the registry identity and key agree. A bare `create('Item')` is not enough to select among unrelated factories.
- Resolve local constants and imported constants used as keys when their values are statically available.
- Allow configuration for custom registration and lookup signatures, key argument positions, and explicit registry identities. Provide manifest overrides for generated registrations and convention-based discovery.

Exit criterion: a static key registration and later static lookup form an explainable connection path without broad string-name false positives.

## Phase 6 - Shared Global State Read/Write Mapping

Record data coupling separately from structural dependencies.

- Recognize configured shared roots, explicit global roots, module singleton exports, and aliases that can be resolved to one of them.
- Extract static property paths for reads, assignments, compound assignments, increments/decrements, `delete`, and statically understood APIs such as `get`, `set`, `update`, and `subscribe`.
- Emit `readsState`, `writesState`, and `deletesState` edges to `state-path` nodes. Track the owning symbol/file, operation, source span, and confidence.
- Distinguish reading a state container from reading a property where syntax permits it. Dynamic property access is reported as a path wildcard only if explicitly enabled.
- Keep state edges out of direct call-path ranking by default, but expose them in a dedicated "shared state coupling" section and graph queries.

Exit criterion: a consumer can see all static readers and writers of a shared state path without mistaking this data coupling for an import or call dependency.

## Phase 7 - Remaining High-Value Connection Touchpoints

Add the general mechanisms that commonly hide relationships in JS/TS repositories.

- Dynamic module loading: resolve literal `import()`, `require`, worker URLs, and configured loaders; preserve dynamic expressions as unresolved observations.
- Callback flow: link a callback symbol passed to a resolved local/imported API when the API signature is known or configured. Keep it separate from an immediate call edge.
- Dependency injection and service containers: model registration and resolution through the same registry protocol system rather than a framework-specific analyzer.
- Reflection and metadata: recognize static `Reflect` metadata, decorator targets, and explicit configuration only when target values are statically available.
- Template and resource references: connect statically referenced templates, stylesheets, schemas, worker scripts, and data artifacts as resources while retaining the relationship mechanism.
- Python parity: use the same graph node/edge contracts for Python imports, globals, events, registries, state, and data artifacts. Implement only the language-specific extraction layer separately.
- Explicit annotations: permit narrowly scoped source comments or `.balk2.json` declarations for relationships that are necessarily dynamic. Manual facts must include provenance and take precedence over heuristics.

Exit criterion: all supported indirection mechanisms either produce a confidence-labeled edge or a visible unresolved observation with an actionable configuration path.

## Phase 8 - Output, Queries, and User Controls

Make the richer graph useful without turning `connection-map.md` into an unbounded dump.

- Preserve the compact V1 overview and add optional sections for indirect connections, shared state, registry paths, and event channels.
- Render evidence and confidence only where it changes interpretation; keep canonical detail in JSON.
- Add query filters for relationship families, confidence thresholds, node kinds, and neighborhood depth. The CLI should support focused output for a file or symbol.
- Bound path traversal by relationship family, depth, cycle handling, and node degree. Default paths should favor direct structural edges, then optionally reveal indirect mechanisms.
- Emit deterministic diagnostics for parse failures, ambiguous resolution, unsupported dynamic constructs, and ignored configuration. Provide a strict CI mode that fails on selected diagnostics.
- Extend `.balk2.json` with sections for `globals`, `protocols.events`, `protocols.registries`, `state`, `annotations`, and output controls, plus a top-level `version` (2 for the 2.0.0 format). Validate it with a published schema.

Exit criterion: users can understand why a connection exists, filter to the relationships relevant to a change, and configure project conventions without editing Balk2 source.

## Phase 9 - Verification and Release

Verification is part of the implementation, not a post-release exercise.

- Unit-test extractors and resolvers with positive, negative, shadowing, duplicate-name, and dynamic-value cases.
- Maintain repository fixture tests that assert the complete canonical graph after normalization. Include at least one fixture per relationship family and mixed-mechanism paths.
- Add mutation-style false-positive tests: same event names on different receivers, repeated registry keys in different containers, local shadows of globals, and unrelated identifiers with identical text.
- Validate deterministic JSON and Markdown across repeated runs and supported platforms.
- Run `typecheck`, linting, formatting checks, the full test suite, and packed-tarball smoke tests in CI.
- Publish a release candidate, install it into clean fixture projects, and compare generated maps against curated expected output before promotion.
- Document behavior changes, graph-schema migration, import/export policy, and configuration migration in the release notes.

Exit criterion: the npm tarball and connection-map output both pass clean-consumer integration tests, regression fixtures, and deterministic-output checks.

## Delivery Order

1. Phase 0 and Phase 1 establish the public package contract and prevent another release with broken consumer imports.
2. Phase 2 creates the repository-wide analysis substrate required by every later connection type.
3. Phase 3 delivers the requested global-symbol fix with strict scope safety.
4. Phases 4 through 6 add event, registry, and state mapping on the common protocol and graph model.
5. Phases 7 through 9 broaden coverage, improve presentation, and gate publication on real consumer verification.

## Definition of Done

V2 is complete when:

- Every documented npm import, type import, CLI command, and intentionally supported module mode works from the packed tarball.
- The connection map resolves standard modules, re-exports, unambiguous globals, static event channels, static registries, and shared-state reads/writes with mechanism-specific edges.
- Indirect relationships are represented by event, registry, or state nodes rather than misleading direct call edges.
- Ambiguous and dynamic constructs are visible as diagnostics or explicitly configured facts, not silently guessed.
- The result is deterministic, schema-versioned, testable through fixtures, and usable across libraries that employ the same underlying JavaScript and TypeScript patterns.
