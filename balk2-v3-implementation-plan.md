# Balk2 V3 - First-Class Python and Rust Plan

## Purpose

V3 makes JavaScript/TypeScript, Python and Rust equally supported languages in the Balk2 connection map. Today only JS/TS has full support. Python's analyzer reads one line at a time and is documented as covering "a small set of mechanisms", not matching JS/TS. Rust has no analyzer at all. V3 brings both Python and Rust up to the JS/TS standard, so a repository like this shows up as one connected graph with the same depth and accuracy in every language:

```text
scripts/collect.py          (Python)
    → generates → data/raw.json
crates/ingest               (Rust binary)
    → consumes → data/raw.json
    → generates → data/titles.parquet
crates/core                 (Rust library, compiled to WebAssembly)
    ← calls ← web/src/search.ts
web/src/data/loadTitles.ts  (TypeScript)
    → consumes → data/titles.parquet
pipeline/registry.py        (Python)
    → registers → registry:pipeline/registry.py:STAGES#normalize → pipeline/normalize.py:run
```

**"Equal respect" is defined in this plan as six concrete commitments, and each one is enforced by a test gate:**

1. **One graph contract.** Every language emits the same node kinds, relationship types, confidence levels, evidence values and diagnostics. Nothing in the graph is specific to one language unless the mechanism exists only in that language.
2. **One mechanism layer.** Events, registries, shared state, callbacks, dynamic loads, resources, data lineage and source annotations are detected by shared engines that work on language-neutral facts. They are not reimplemented once per language. Each language provides its own syntax front end and its own built-in protocol catalog.
3. **One capability matrix.** `docs/v3/language-parity.md` lists every mechanism family against every language. Each cell says **Supported**, **Not applicable** (with a reason based on the language's semantics, never on an analyzer weakness), or **Deferred** (with a tracking issue). The 3.0.0 release gate allows no Deferred cells beyond the ones listed in this plan.
4. **One parity corpus.** Language-neutral scenarios are written once per language with one expected graph shape. A test fails if any language produces a different shape.
5. **One accuracy bar.** The recall and false-positive budgets are the same for every language and every family, and they are reported per language in CI.
6. **One oracle each.** Every language's resolution is checked in Balk2's own CI against its real toolchain: the TypeScript compiler for JS/TS, CPython's `ast` and `importlib` for Python, and `rustc` dependency files for Rust. Users never need any toolchain at runtime.

V3 keeps the V1 and V2 rules. Edges come from resolved facts, not matching names. Anything uncertain is labeled as uncertain. Anything dynamic is reported, not guessed. The graph is deterministic. Project conventions go in configuration, not in special-case analyzer code.

## Findings From the 2.0.x Codebase

### Asymmetries between languages

- **Different analyzer contracts.**
  - `JsTsAnalyzer` analyzes the whole repository at once through a shared `RepositoryProgram` (`analyzeRepository`), using the TypeScript `TypeChecker`.
  - `PythonAnalyzer` implements only the per-file `Analyzer.analyzeFile`. Every call is independent, so it cannot resolve a name defined in another file except through a direct import.
  - `buildConnectionGraphDetailed` in `src/cli/build-graph.ts` hard-codes both paths, and step 5 collects every per-file analyzer's input into a map called `pythonFiles`.
- **Python is parsed with line-by-line regex.** `python-analyzer.ts` (419 lines) matches imports, classes, functions and calls with regular expressions, and tracks scope with indentation heuristics. `docs/v2/python-protocols.md` documents the consequences:
  - Calls and `importlib` calls that span several lines are not recognized.
  - Rebound aliases are not followed.
  - Nested functions take their enclosing owner.
  - Registries, callbacks, events and state "are JavaScript and TypeScript analyses. They are not applied to Python files."
  - No syntax diagnostics are reported for Python.
- **Mechanism detectors are tied to the TypeScript AST.** `event-channels.ts`, `registry-detection.ts`, `state-paths.ts`, `callback-flow.ts`, `module-loads.ts`, `resource-detection.ts` and `metadata-reflect.ts` all work directly on `ts.Node`. The protocol catalogs and the `.balk2.json` protocol sections have no notion of language. They apply to JS/TS implicitly and nowhere else.
- **Receiver rules depend on the TypeScript checker.** The event `event-like` receiver rule checks the receiver's type with the TypeScript checker. Python has nothing equivalent, so the rule cannot be applied to Python even if the detector were shared.
- **Owners are defined per language.** `owner.ts` defines owners in terms of `ts.Node`, while Python uses `ownersByLine`, which is based on indentation. The two languages can disagree about which function owns a nested statement.

### Rust gaps

- No Rust analysis exists.
- Every `.toml` file, including `Cargo.toml`, `rust-toolchain.toml`, `rustfmt.toml` and `.cargo/config.toml`, is registered as a TOML data artifact. Python's `pyproject.toml` is treated the same way.
- `target/` is not in `DEFAULT_EXCLUDES`. After a `cargo build`, the scan would include thousands of generated files.

### Shared constraints

- **Generation is synchronous.** `generateConnectionMap`, `checkConnectionMap` and `buildConnectionGraphDetailed` are synchronous public APIs. Any parser that needs async setup (such as `web-tree-sitter`'s WASM init) would force a breaking change to the API.
- **Only one runtime dependency.** The runtime dependency footprint is just `typescript`. Anything new must work from the packed ESM and CJS builds (`npm run test:package`).
- **Shared direction keywords.** `WRITE_KEYWORDS`/`READ_KEYWORDS` in `src/data/data-analyzer.ts` are one list shared by JS and Python, matched as text, with no knowledge of which API a call actually resolves to.
- **Missing union values.** `SymbolType` has no struct, enum, trait, module or macro. `NodeKind` has no package. `Evidence` has no value for facts read from a manifest. V2 treated new union values as breaking for TypeScript consumers who switch over them exhaustively.
- **Linux-only CI.** CI runs only on `ubuntu-latest`, but resolution depends on paths and the maintainer works on Windows.

## V3 Design Principles

- **Front ends extract facts and engines interpret them.** A language front end parses, builds scopes, resolves modules and bindings, and emits language-neutral facts: declarations, module edges, resolved references, call sites with receiver identity and type, assignments, path values and directives. Mechanism engines turn facts into graph edges. Language-specific logic lives only in the front ends and in per-language catalog entries.
- **The language's own module system is the source of truth.**
  - JS/TS uses TypeScript module resolution.
  - Python uses import-system semantics: import roots, regular and namespace packages, precedence of `__init__`, and relative import levels.
  - Rust uses the module tree reachable from each crate root.
- **Resolve through bindings, not text.** All three front ends implement lexical scopes and shadowing. A method call on a receiver of unknown type emits no edge in any language.
- **Type facts are graded, not assumed.** JS/TS has full checker types. Python and Rust use declared annotations and constructor results, following the same documented local-type rules (Phase 2.4), with a confidence for each source. The capability matrix states where the depth differs and why.
- **No toolchain at runtime.** `balk2` never runs `tsc` as a process, `python`, `cargo`, `rustc` or a language server during `generate`, `check` or the git hook.
- **All conditional branches count.** Every `cfg` branch, `if TYPE_CHECKING:` block, `try/except ImportError` fallback and `typeof window` guard is analyzed. Conditions are kept as metadata, never evaluated.
- **No language is the default.** Built-in catalogs, docs, fixtures and Markdown sections are organized the same way for every language.
- **Regression policy.**
  - JS/TS-only repositories may gain edges only where a parity rule adds a mechanism to every language. Each such rule is listed in the release notes.
  - No JS/TS edge is removed unless it is shown to have been a false positive.
  - Python output changes are expected. Every removed Python edge must be shown to have been a false positive. Every new edge must be covered by a corpus fixture.

## Open Decisions (Settle in Phase 0)

| ID  | Decision                                           | Options                                                                                                                                                                                                         | Recommendation                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | How to parse Python and Rust                       | (A) Hand-written TypeScript tokenizers and parsers. (B) `web-tree-sitter` with WASM grammars. (C) Native `tree-sitter`. (D) Keep regex for Python.                                                              | **A for both.** It is synchronous, adds no dependencies, works the same on every platform, and Balk2 controls error recovery and spans. B needs async init (an API break) and adds WASM files to `dist`. C needs native builds and adds install risk on Windows. D rules out equal respect. |
| D2  | How to parse TOML (`Cargo.toml`, `pyproject.toml`) | (A) Add a small, synchronous, dependency-free parser such as `smol-toml`. (B) Hand-write a TOML subset.                                                                                                         | **A.** Both ecosystems depend on TOML, and a subset parser would be wrong some of the time. Check it from the packed tarball.                                                                                                                                                               |
| D3  | Schema and package version                         | (A) Connection map `version: 3`, package `3.0.0`, config `version` accepts 2 or 3. (B) Add the new values to schema version 2 in a 2.x minor release.                                                           | **A.** V3 adds a node kind, union values and new kinds of output for every language. V2 treated exactly these changes as major.                                                                                                                                                             |
| D4  | How packages and crates are represented            | (A) A `package` node kind for every ecosystem (npm, Python, Cargo). (B) A Cargo-only `crate` node.                                                                                                              | **A.** npm workspaces, Python projects and Cargo crates are all distribution and dependency units. One node kind keeps the languages symmetric.                                                                                                                                             |
| D5  | Test code                                          | Include and tag it, or exclude it.                                                                                                                                                                              | **Include and tag it, in every language.** That covers `*.test.ts`, `test_*.py`/`conftest.py`, `#[cfg(test)]` and `tests/`. `include.tests: false` excludes test code for all languages.                                                                                                    |
| D6  | Method naming                                      | Pick naming rules for each case.                                                                                                                                                                                | **`Type.method` everywhere for methods defined in a class or inherent impl.** A Rust trait-impl method is `Type[Trait].method`, because `impl Display` and `impl Debug` both define `fmt`. Python nested classes become `Outer.Inner.method`, as do nested classes in JS/TS.                |
| D7  | Whether JS/TS moves onto the shared engines        | (A) Move JS/TS detectors onto the facts layer, gated by zero-diff snapshots. (B) Leave JS/TS detectors on the TypeScript AST, and share only the catalogs, config and policies.                                 | **Decided: A.** B is the fallback only for a family that cannot reach zero diff. A is the only structure in which parity cannot drift over time. Any family that falls back to B gets its own parity tests in the corpus.                                                                   |
| D8  | State inferred from module-level variables         | (A) In every language, a module-level binding reassigned inside a function is state: JS/TS `let`, Python `global`, Rust `static mut` and interior-mutable statics. (B) Only Python and Rust get this inference. | **Decided: A.** Equal treatment means JS/TS repositories gain these edges too. The change is additive and listed in the release notes.                                                                                                                                                      |

## Target Graph Model Additions

### Node kind: `package`

```json
{
  "kind": "package",
  "id": "package:cargo:crates/ingest#bin:ingest",
  "ecosystem": "cargo",
  "name": "ingest",
  "target": "bin",
  "manifest": "crates/ingest/Cargo.toml",
  "roots": ["crates/ingest/src/main.rs"],
  "edition": "2021"
}
```

The id has the form `package:<ecosystem>:<manifest dir>[#<target kind>:<target name>]`.

| Ecosystem | Source                                                                                   | `name`                                    | `roots`                                            | Targets                                                                |
| --------- | ---------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| `npm`     | `package.json` (and its workspaces)                                                      | `name`                                    | Entry files from `exports`, `main` and `bin`       | `lib`, `bin`                                                           |
| `python`  | `pyproject.toml` (PEP 621, setuptools, Poetry, Hatch, PDM, Flit, maturin) or `setup.cfg` | Distribution name                         | The import root directories and top-level packages | `lib`, plus `script` for each `[project.scripts]` entry                |
| `cargo`   | `Cargo.toml`                                                                             | Name as used in code (`-` changed to `_`) | The crate root file                                | `lib`, `bin`, `test`, `example`, `bench`, `build-script`, `proc-macro` |

### New `SymbolType` values

`struct`, `enum`, `trait`, `module` (inline Rust `mod x { }`, and TS `namespace`), and `macro`. A Python class is a `class`, and a TS `enum` becomes `enum`. That last change replaces however JS/TS records enums today; Phase 0 confirms the current representation, and if TS enums are currently recorded as something else, the change is listed in the release notes. A Python `Enum` subclass stays a `class` with `metadata.enum: true`, because in Python it is a class.

### Symbol naming (all languages)

| Item                       | JS/TS                  | Python                 | Rust                                                              |
| -------------------------- | ---------------------- | ---------------------- | ----------------------------------------------------------------- |
| Top-level function         | `src/u.ts:parse`       | `pkg/u.py:parse`       | `src/u.rs:parse`                                                  |
| Class, struct or trait     | `src/m.ts:User`        | `pkg/m.py:User`        | `src/m.rs:User`                                                   |
| Method                     | `src/m.ts:User.save`   | `pkg/m.py:User.save`   | `src/m.rs:User.save` (named by the file that contains the `impl`) |
| Trait-impl method          | n/a                    | n/a                    | `src/m.rs:User[Display].fmt`                                      |
| Nested class               | `src/m.ts:Outer.Inner` | `pkg/m.py:Outer.Inner` | n/a                                                               |
| Inline module or namespace | `src/m.ts:NS::f`       | n/a                    | `src/lib.rs:tests::helper`                                        |
| Macro                      | n/a                    | n/a                    | `src/m.rs:my_macro!`                                              |

Generic parameters are dropped. When the same item is defined in more than one conditional branch (`cfg` twins, or `try`/`except ImportError` fallback definitions), the definitions become one symbol whose metadata lists every condition.

### New relationship types

| Type             | From → To                              | Used by                                                                                                                                                                                                   | Family |
| ---------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `declaresModule` | parent module file → child module file | Rust `mod foo;`                                                                                                                                                                                           | code   |
| `dependsOn`      | package → package                      | Internal dependencies declared in npm workspaces, Python path/workspace dependencies (uv, Poetry, PDM), and Cargo path/workspace dependencies. `metadata.kind` is `normal`, `dev`, `build` or `optional`. | code   |
| `packageRoot`    | package → file                         | All ecosystems                                                                                                                                                                                            | code   |
| `executes`       | owner → file                           | A literal subprocess or script invocation in any language (Phase 14.5)                                                                                                                                    | code   |

Existing relationship types are reused wherever their meaning already fits: `imports`, `exports`, `calls`, `passesCallback`, `extends`, `implements`, `references`, the event, registry, state, metadata and resource relationships, and the data relationships. Re-exports (TS barrels, Python `__init__.py` re-exports, Rust `pub use`) use one representation, the one JS/TS uses today, which Phase 0 documents.

### Other additions

- **`Evidence`** gains `manifest` for facts read from `package.json`, `pyproject.toml` or `Cargo.toml`.
- **`LoadKind`** gains:
  - `include-macro`: Rust `include!`.
  - `dunder-import`: Python `__import__`.
  - `spec-from-file`: Python `importlib.util.spec_from_file_location`.
  - `run-path`: Python `runpy`.
  - `wasm-bindgen-module`: a JS file imported by Rust through `wasm-bindgen`.
- **`StateRootKind`** gains `module`, for a module-level binding treated as state under D8: Rust statics, Python module globals, and JS/TS module `let`.
- **`UnresolvedReason`** gains:
  - `unresolved-module-path`: an internal-looking import or path that cannot be resolved, in any language.
  - `ambiguous-star-import`: Python `*` and Rust globs.
  - `dynamic-include-path`.
  - `unresolved-binding`: a cross-language consumer whose producer cannot be found.
- **Diagnostic kinds** (usable with `--fail-on`):
  - `manifest`: a package manifest that cannot be parsed or names a missing path.
  - `unreachable-module`: a Rust file that no crate root reaches.
  - `module-conflict`: Rust has both `foo.rs` and `foo/mod.rs`.
  - `shadowed-module`: Python `pkg/x.py` is hidden by the package `pkg/x/`.
  - `syntax`: now reported for Python and Rust too.
- **Language tags on file nodes:** `javascript`, `typescript`, `python`, `rust`. Manifests become file nodes tagged `npm-manifest`, `python-manifest` or `cargo-manifest`, and are no longer data artifacts.

## Phase 0 - Contracts, Parity Matrix, and Baselines

- 0.1 Record decisions D1–D8 in `docs/v3/phase-0-contract.md`, using the V2 contract format. Include the public API inventory (`PythonAnalyzer`, `RustAnalyzer`, the facts types if exported, and the new graph types) and the runtime matrix: Node 18/20/22 on Linux and Windows.
- 0.2 Write `docs/v3/language-parity.md`, the capability matrix. Rows are the mechanism families: modules and imports, re-exports, exports, symbols, calls, method calls, inheritance and implementation, type references, globals, events, registries, shared state, callbacks, dynamic loads, resources, metadata, data lineage, process execution, source annotations, syntax diagnostics, packages, and cross-language boundaries. Columns are JS/TS, Python and Rust. Every cell is filled in now, and every Not applicable cell gives its semantic reason. The expected Not applicable cells are:
  - JS-style global objects (Rust has no implicit global object; Python's equivalent is `builtins`).
  - `Reflect` metadata (Python and Rust have no runtime metadata API keyed by strings; Python decorators are covered by registries and references instead).
  - String-named event channels in Rust, where channels connect by passing values.
- 0.3 Inventory how JS/TS currently represents re-exports, barrels, type-only imports, enums, namespaces, owners for nested functions, and decorators. Each becomes the shared representation, or gets a documented shared replacement. Python and Rust then follow the same shapes.
- 0.4 Write `docs/v3/connection-map-schema.md`. It covers the package node, the new union values, relationships, evidence, reasons and diagnostics, and how v1 and v2 maps read under v3 (`packages` table empty, everything else unchanged).
- 0.5 **Parity corpus format** (`src/testing/parity-corpus.ts`). Each scenario has one language-neutral expectation, written with placeholders (`{mod:a}`, `{sym:a.helper}`), and a JS/TS, Python and Rust rendition of the same code. A Not applicable cell from the matrix is the only allowed reason to skip a language. The seed scenarios are:

  | Kind                       | Scenarios                                                                                                                                                                                                                                                                                                                 |
  | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Imports and calls          | An imported function is called. A re-export chain passes through three modules. A star or glob import has a collision.                                                                                                                                                                                                    |
  | Methods                    | A method is called through a typed parameter. A method is called through a constructor result. A method is called on a receiver of unknown type (negative). A base-class method is reached through `super`.                                                                                                               |
  | Shadowing (negative)       | Same-named functions in sibling modules. A local binding shadows an import.                                                                                                                                                                                                                                               |
  | Mechanisms                 | An event is published and subscribed, and the same event name on two different receivers does not connect (negative). A registry key is registered and looked up, and the same key in two registries does not connect (negative). A module-level state variable is written and read. A callback is passed to a known API. |
  | Loads, data and directives | A literal dynamic load. A dynamic load with a non-literal specifier (observation). A data pipeline write followed by a read. A file-relative data path (`__dirname`, `Path(__file__)`, `CARGO_MANIFEST_DIR`). A source annotation. A syntax error is recovered from.                                                      |

- 0.6 **Per-language corpora.** Add `python-corpus.ts` and `rust-corpus.ts` for mechanisms specific to one language, in the style of `mixed-corpus.ts`. Language-specific negative cases:
  - **Python:** `from pkg import x`, where `x` is either a submodule or an attribute; namespace packages; an `if TYPE_CHECKING:` import; a `try/except ImportError` fallback; a rebound alias; a comprehension scope; `nonlocal`/`global`; a decorator that replaces the function it decorates; `match` soft keywords used as names; f-strings with nested quotes (PEP 701).
  - **Rust:** `cfg` twin modules; a macro that generates an item; `mod foo;` inside a raw string; nested block comments; `'a'` versus `'a`; `r#type`; an unreachable file; both `foo.rs` and `foo/mod.rs` present; `Display`/`Debug` `fmt`.
- 0.7 **Budgets.** The same budgets apply to every language: 100% recall of declared high-confidence edges, zero declared false positives, and a performance budget measured on synthetic repositories of 1,000 files and about 150k lines, generated in each language.
- 0.8 **Python baseline.** Snapshot the current Python output for every existing Python test and fixture. This becomes the floor: every existing positive must survive Phase 5, unless it is shown to be a false positive and recorded in `docs/v3/python-changes.md`.

Exit criterion: the contract, matrix, schema, corpus formats and budgets are documented. The parity corpus passes for JS/TS where V2 already supports the scenario. Python and Rust expectations fail, as expected.

Verify: `npm run typecheck && npm run lint && npx vitest run src/analyzer/parity` (Python and Rust are expected to fail).

## Phase 1 - Language-Neutral Orchestration and Graph Types

- 1.1 **Analyzer interface.** Add a `LanguageFrontEnd` interface in `src/analyzer/types.ts`. A front end takes the scanned file list, root directory, config and package model, and returns facts, syntax notes, problems and its binding index exports (Phase 14). JS/TS, Python and Rust each implement it.
  - Keep `Analyzer.analyzeFile` as a public compatibility wrapper that runs a session over one file, and document it as deprecated in 3.0.0.
- 1.2 **Pipeline.** Rewrite `buildConnectionGraphDetailed` as a fixed sequence:
  1. Scan.
  2. Package discovery.
  3. Every front end.
  4. The binding index.
  5. Cross-language resolution.
  6. Mechanism engines.
  7. Annotations.
  8. Explicit lineage.

  The order is independent of language and deterministic. Remove `pythonFiles` and the per-file loop.

- 1.3 **Scanning.**
  - Exclude Cargo `target/` only where a sibling `Cargo.toml` exists (or a configured `target-dir`).
  - Exclude Python `__pycache__`, `.venv`/`venv` (only where a `pyvenv.cfg` exists), `.tox`, `.nox`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `*.egg-info` and `build/lib*`.
  - Ignore lock files: `Cargo.lock`, `poetry.lock`, `uv.lock` and `pdm.lock`, along with the npm locks already handled.
- 1.4 **Manifests are not data.** `package.json`, `pyproject.toml`, `setup.cfg`, `Cargo.toml` and the tool config files (`tsconfig*.json`, `rust-toolchain.toml`, `rustfmt.toml`, `clippy.toml`, `.cargo/config.toml`, `ruff.toml`, `mypy.ini`) become manifest file nodes, not data artifacts. This is listed in the release notes as an output change for every ecosystem.
- 1.5 **Graph types.** Add the v3 types to `src/types.ts`, `ConnectionGraph`, serialization, `RELATIONSHIP_FAMILIES`/`FAMILY_TYPES` in `src/query/map-query.ts`, and `deserializeConnectionMap`, which must read v1, v2 and v3. Update the hygiene and reverse-link tests.
- 1.6 **CI.** Add `windows-latest` to the CI matrix.

Exit criterion: all existing tests and snapshots pass, with only the documented manifest change. A v2 map reads under v3. The existing Python analyzer runs unchanged behind a temporary adapter for the `LanguageFrontEnd` interface, which is removed in Phase 5.

Verify: `npm run verify` on Linux and Windows.

## Phase 2 - Shared Facts Layer and Mechanism Engines

Build the layer that makes parity structural rather than something maintained by hand.

- 2.1 **Facts model** (`src/facts/`). The fact types are:
  - `Declaration`: id, kind, name, owner, span, visibility, exported, condition.
  - `ModuleEdge`: import, re-export, declare-module, include or load. It carries names, a type-only flag and a condition.
  - `ResolvedReference`: the owner, a target (symbol, external or unresolved), a role (`call`, `construct`, `type`, `decorator` or `value`), the span and the confidence.
  - `CallSite`: the owner, a callee reference, the receiver (`identity` as a symbol, state root or unknown; `type` as a symbol, an external name or unknown), the method name, positional and keyword arguments as `ArgValue`, and the span.
  - `ArgValue`: a static string, number or path value, or a symbol reference, or unknown.
  - `Assignment`/`Read`/`Delete`: on a `StatePathFact`.
  - `Directive`: a source annotation.
- 2.2 **Path value evaluator.** One evaluator, shared by all languages, for literals, joins and anchors. Anchors are:
  - `file-dir`: JS `__dirname`/`import.meta.url`, Python `Path(__file__).parent`/`os.path.dirname(__file__)`.
  - `package-dir`: Rust `CARGO_MANIFEST_DIR`.
  - `cwd`: a bare relative path.

  Each language supplies only the way its syntax maps to evaluator operations. The existing `data-literals.ts` filters (URLs, placeholders, web-root paths, bare extensions) move here and apply to every language.

- 2.3 **Engines.** Events, registries (including injection), state, callbacks, module loads, resources, metadata, data lineage and annotations each become one engine that consumes facts plus a catalog. Every catalog entry has `languages: [...]`. Matching is on the resolved callee or receiver (for example "`std::fs::read_to_string`", "`pathlib.Path.write_text`", "`fs.writeFileSync`"), never on bare method-name text, except where an entry is explicitly marked `receiver: "any"`.
- 2.4 **Local type rules**, shared by Python and Rust and used by JS/TS only when the checker returns no type:
  - An annotated parameter or variable is high confidence.
  - The result of calling a resolved constructor or class is high.
  - The result of calling a resolved function whose declared return type is an internal type or `Self` is medium.
  - These wrappers are peeled to reach the receiver type: Python `Optional[...]`, `X | None` and `Annotated[...]`; Rust `&`, `&mut`, `Box`, `Rc` and `Arc`. JS/TS needs no peeling rules because the checker already gives the type.
  - A rebinding to a different type removes the type fact.
- 2.5 **Receiver rules per language.** `event-like`, and the corresponding registry and state receiver tests, use the front end's type-members query:
  - **JS/TS:** checker types.
  - **Python:** a class in the repository with its bases (C3 order), plus a small catalog of known library types.
  - **Rust:** inherent and trait impl methods of the type.
- 2.6 **Owners.** One owner rule for all languages, defined in Phase 0.3. Front ends report owners with the same rule, and `owner.ts` and `ownersByLine` are replaced.
- 2.7 **Moving JS/TS onto the engines (D7).** Move the JS/TS detectors one family at a time onto the facts layer. Each family's move is accepted only when the existing snapshots (`test/snapshots/*.txt`) and accuracy suites are byte-identical. A family that cannot get there stays on the TypeScript AST under D7(B), and is recorded in the parity doc.

Exit criterion: JS/TS runs entirely, or per the recorded D7 exceptions, on facts and engines with zero snapshot diff. The engines have unit tests that use synthetic facts with no front end involved.

Verify: `npm run verify && npx vitest run src/facts`.

## Phase 3 - Python Front End: Tokenizer and Parser

- 3.1 **Tokenizer** (`src/analyzer/python/tokenizer.ts`). It must handle:
  - INDENT and DEDENT, with tabs and spaces handled as CPython does.
  - Implicit line joining inside brackets, and backslash continuations.
  - Comments, and encoding declarations (as trivia).
  - String prefixes (`r`, `b`, `u`, `f`, `rb`/`br`, `fr`/`rf`, `t` for 3.14 template strings), triple quotes, and f-strings as nested token streams under PEP 701 (nested quotes and nested expressions).
  - Numbers, including `_` separators.
  - Soft keywords: `match`, `case`, `type`, `_`.
  - Operators, including `:=`, `->` and `**`.
  - CRLF and BOM.
  - Every token carries a line and column, so `SourceSpan` values match the existing spans.
- 3.2 **Parser.** A recursive-descent statement parser with expressions parsed by precedence climbing. Target syntax is Python 3.8–3.13 (plus 3.14 where it is cheap), including:
  - decorators, `async`/`await`, walrus, lambdas, comprehensions and generators
  - `match` statements
  - PEP 695 `type` aliases and generic `def f[T]()`
  - star expressions, `global`/`nonlocal`, `del`, `with` items and `try`/`except*`

  Python 2 syntax is reported as `syntax`.

- 3.3 **Error recovery.** Recover at statement boundaries and at dedents. Report errors through `SyntaxErrorNote`, so `--fail-on syntax` covers Python.
- 3.4 **CPython oracle.** In a Balk2 CI job only, parse every Python fixture, plus a pinned set of real-world files, with CPython's `ast`. Compare the inventories of definitions, imports, call sites and assignments with Balk2's parse.

Exit criterion: every Python fixture parses, malformed files produce syntax notes and never throw, and the inventories match CPython's `ast` exactly on the oracle set.

Verify: `npx vitest run src/analyzer/python/` plus the `python-oracle` CI job.

## Phase 4 - Python Project Model and Module Resolution

- 4.1 **Project discovery.** Read `pyproject.toml` for:
  - `[project]` name, dependencies, `scripts` and `entry-points`.
  - `[tool.setuptools]` `package-dir`/`packages.find` `where`.
  - `[tool.poetry]` `packages`.
  - `[tool.hatch.build.targets.wheel]` `packages`.
  - `[tool.pdm]`.
  - `[tool.maturin]` `python-source`/`module-name`.

  Also read `setup.cfg` and literal `setup.py` arguments (`packages=`, `package_dir=`), and `uv`/Poetry/PDM workspace and path dependencies for `dependsOn`. Emit `package` nodes with `evidence: "manifest"`.

- 4.2 **Import roots.** In order of precedence:
  1. Configured `python.roots`.
  2. Roots declared in manifests.
  3. A `src/` layout.
  4. The repository root.
  5. For scripts, the directory of the importing script, which is what `sys.path[0]` is when the script runs.

  Each root is a fact, so the map can explain why an import resolved.

- 4.3 **Import semantics.**
  - **Packages and modules.** Regular packages (`__init__.py`) take precedence over a same-named module, and the hidden module gets a `shadowed-module` diagnostic. Namespace packages (PEP 420) are supported. `.pyi` stubs count for types and references, but `imports` edges point at the `.py` file when one exists. Compiled extension modules resolve through Phase 14.
  - **Import forms.**
    - `import a.b.c` binds `a` and imports `a/b/c`.
    - `from pkg import x` resolves to an attribute defined in `pkg/__init__.py` first, then to the submodule `pkg/x.py`, as CPython does.
    - Relative imports follow their level.
    - `from x import *` uses `__all__` when it is statically a list or tuple of literals, and public names otherwise.
  - **Conditions.** `if TYPE_CHECKING:` imports carry `typeOnly: true`, in the same representation as TS `import type`. `try/except ImportError` alternatives are each recorded with a condition.
- 4.4 **Re-exports and exports.**
  - A module's exports are `__all__` if it is statically known; otherwise every public top-level name that is not an underscore name and not an import, except imports re-exported in a package `__init__.py` or with the redundant-alias form `from .x import Y as Y`.
  - Re-exports use the shared JS/TS representation.
- 4.5 **Entry points.** `[project.scripts]` and `[project.entry-points."group"]` entries (`name = "pkg.mod:obj"`) become `packageRoot` edges for scripts, and `registers` edges from `registry:entry-points:<group>#<name>` to the target symbol, so plugin groups are traceable.
- 4.6 **`importlib` oracle.** In a Balk2 CI job only, resolve every import in the Python fixtures with `importlib.util.find_spec` under the fixture's configured roots, and assert that Balk2 resolves to the same file.

Exit criterion: the Python module-resolution fixtures (src layout, namespace packages, submodule versus attribute, relative levels, stubs, conditional imports, star imports with and without `__all__`) match the `importlib` oracle.

Verify: `npx vitest run src/analyzer/python/modules` plus the `python-oracle` job.

## Phase 5 - Python Names, Symbols, Calls, and Types

- 5.1 **Scopes.** Implement Python scoping in full:
  - Local, enclosing, global and builtin scopes (LEGB).
  - A class body is not an enclosing scope for its methods.
  - Comprehensions get their own scope.
  - `global` and `nonlocal` are honored.
  - A conditional or repeated definition binds the union of its definitions.
  - `del` unbinds the name.
  - A name bound by assignment, `for`, `with`, `except`, `import`, `match` capture, walrus, or a parameter is local unless declared otherwise.
- 5.2 **Symbols.**
  - Classes, functions and methods (including `@staticmethod`, `@classmethod` and `@property`).
  - Nested classes, as `Outer.Inner`.
  - Module-level constants (an `UPPER_CASE` name or a `Final` annotation) and variables.
  - Dataclass and `NamedTuple` fields as references to their annotated types.
  - Owners follow the shared rule from 2.6.
- 5.3 **Inheritance.**
  - Base classes emit `extends`. The class's method resolution order over classes in the repository is computed with C3 linearization.
  - Subclasses of `typing.Protocol` and `abc.ABC`/`ABCMeta` carry `metadata.abstract: true`.
  - `SomeABC.register(Cls)` emits `implements`.
- 5.4 **Calls.** A call resolves when the callee is:
  - a name, through scopes
  - `module.attr`, through imports
  - `Class(...)`, which emits `calls` to the class with role `construct`, and to `Class.__init__` when it is defined
  - `self.m()` or `cls.m()`, through the method resolution order
  - `super().m()`, through the class after the current one in the method resolution order
  - a typed receiver (2.4)
  - `functools.partial(f)` or `f.__call__`
- 5.5 **Decorators.**
  - Applying a decorator emits `calls` from the decorated symbol's owner context to the decorator, with `metadata.mechanism: "decorator"`.
  - A decorator known to return its argument unchanged (`functools.wraps`-style, `dataclass`, `property`, `staticmethod`, `classmethod`, `cache`, `lru_cache`, `contextmanager`, or configured) keeps the decorated symbol as the call target. Any other decorator also keeps the target, but calls to the decorated symbol drop to medium confidence.
- 5.6 **References.** Annotations (including string forward references parsed as expressions), base classes, `isinstance`/`issubclass` targets, `except` classes and `match` class patterns emit `references`.
- 5.7 **Retire the old analyzer.** Delete the line-based implementation in `python-analyzer.ts`. `PythonAnalyzer` becomes the front end and its compatibility wrapper. Rewrite `docs/v2/python-protocols.md` as `docs/v3/languages/python.md`, with the same structure as the JS/TS and Rust docs.

Exit criterion: the Phase 0.8 Python baseline is met (every former positive is present or documented as a false positive). The Python parity-corpus scenarios for modules, calls, methods, inheritance and shadowing pass.

Verify: `npx vitest run src/analyzer/python src/analyzer/parity`.

## Phase 6 - Rust Front End: Lexer and Parser

- 6.1 **Lexer** (`src/analyzer/rust/lexer.ts`). It must handle:
  - identifiers, including raw identifiers (`r#type`) and Unicode identifiers through `\p{XID_Start}`/`\p{XID_Continue}`
  - lifetimes versus char literals
  - strings, byte strings, C strings and raw strings with any number of `#`
  - nested block comments
  - doc comments, as trivia
  - a shebang line versus `#![...]`
  - suffixed numbers and all punctuation

  CRLF and BOM are handled, and every token carries a span.

- 6.2 **Token trees.** Group tokens into balanced `()`, `[]` and `{}` trees, recover at item boundaries, and report syntax errors as `SyntaxErrorNote`.
- 6.3 **Items.** Parse:
  - attributes (`cfg`, `path`, `macro_export`, `macro_use`, derives, and others kept raw)
  - visibility (`pub`, `pub(crate)`, `pub(super)`, `pub(in path)`)
  - `mod` and `use` trees (groups, `self`, globs, renames, `as _`)
  - `extern crate`
  - `fn` with its qualifiers, generics, parameters and return type
  - `struct`, `enum` and `union`
  - `trait` with supertraits
  - inherent and trait `impl`
  - `type`, `const`, `static` and `static mut`
  - `macro_rules!`
  - `extern` blocks
  - macro invocations in item position
- 6.4 **Function bodies.** Scan for path calls, method calls, struct literals, paths, `let` bindings with optional types, closures and macro invocations, and collect every name a pattern binds.
- 6.5 **Robustness tests.** Add unit tests for every token class and item form. Add a fuzz-style test that randomly truncates every fixture and requires that the lexer never throws and always terminates.

Exit criterion: every Rust fixture parses, and malformed input produces syntax notes.

Verify: `npx vitest run src/analyzer/rust/`.

## Phase 7 - Cargo Packages and Crates

- 7.1 **Manifests.** Parse each `Cargo.toml` (D2):
  - `[package]`, including `edition`, `build` and the `auto*` flags
  - `[lib]` (`name`, `path`, `proc-macro`)
  - `[[bin]]`, `[[example]]`, `[[test]]` and `[[bench]]`
  - all dependency tables, including target-specific ones
  - `[workspace]` `members`/`exclude`, `[workspace.dependencies]` and `[workspace.package]` inheritance
- 7.2 **Targets.** Expand workspace member globs and support virtual manifests. Apply Cargo's auto-discovery rules for targets, with explicit tables taking precedence. Emit one `package` node per target, each with a `packageRoot` edge.
- 7.3 **Dependencies.**
  - A path or workspace dependency inside the repository emits `dependsOn` with `evidence: "manifest"`. Its kind and `cfg` go in metadata.
  - The dependency key is the name used in code, after a `package = "..."` rename and with `-` changed to `_`.
  - Registry and git dependencies go into an extern-name table, so `use serde::...` is known to be external rather than unresolved.
  - Every bin, test, example and bench target implicitly depends on its package's lib.
- 7.4 **Problems.** Manifests that cannot be parsed, missing members and missing target paths produce `manifest` diagnostics.
- 7.5 **npm parity.** The same phase emits `package` nodes for `package.json` workspaces: `workspaces` globs, `name`, entries from `exports`/`main`/`bin`, and internal dependencies (`workspace:` protocol, or a version range satisfied by a workspace package). This makes package modeling symmetric across all three ecosystems.

Exit criterion: the Cargo fixtures (single crate, virtual workspace, renames, custom `[[bin]]` path, proc-macro, `build.rs`) and the npm and Python workspace fixtures produce the expected package nodes and `dependsOn` edges.

Verify: `npx vitest run src/analyzer/rust/cargo src/packages`.

## Phase 8 - Rust Module Tree

- 8.1 **`mod foo;` resolution**, following the Rust Reference:
  - In a mod-rs file, `foo` is `<dir>/foo.rs` or `<dir>/foo/mod.rs`.
  - In a non-mod-rs file `src/a.rs`, `foo` is `src/a/foo.rs` or `src/a/foo/mod.rs`.
  - Inside an inline module, the inline module's name is added as a directory.
- 8.2 **`#[path]`.** Support the attribute's rules for mod-rs and non-mod-rs files and inside inline modules, accepting both `/` and `\`.
- 8.3 **Edges.** Emit `declaresModule` edges with `metadata.cfg`. `cfg` twins produce one edge for each candidate.
- 8.4 **Crate files.** A crate's files are the closure of `declaresModule` edges from its root.
  - A file no crate reaches gets `unreachable-module`.
  - When both module candidates exist, emit `module-conflict` and resolve to neither.
  - A file reached by more than one crate is resolved once per crate, and the resulting edges are merged.
- 8.5 **`rustc` oracle.** In a Balk2 CI job only, run `cargo build --all-targets` on the oracle workspaces and compare against the dep-info files (`target/debug/deps/*.d`), which list every source file and every `include_*` input.

Exit criterion: module trees match the `rustc` oracle exactly.

Verify: `npx vitest run src/analyzer/rust/modules` plus the `rust-oracle` job.

## Phase 9 - Rust Names, Symbols, Calls, and Traits

- 9.1 **Namespaces.** Each module has separate type, value and macro namespaces, and symbols follow the naming table.
- 9.2 **Paths.**
  - `crate::`, `self::` and `super::` (repeatable).
  - `::name` names an extern crate in edition 2018 and later, and the crate root in 2015.
  - A first segment can be an extern crate (through the Phase 7 table, `extern crate ... as` aliases, or `std`/`core`/`alloc`/`proc_macro`/`test`).
  - In edition 2018 and later, uniform paths apply. When a local name and an extern crate name conflict, the result is an `unresolved-module-path` observation.
- 9.3 **`use` trees and globs.** Expand `use` trees and emit `imports` from file to file. Glob names have the lowest precedence, and a name supplied by two globs produces `ambiguous-star-import`, the same reason as for Python.
- 9.4 **Exports.** An item is exported when some path from the crate root reaches it through public modules or `pub use`, computed as a fixed point. Exports are emitted only for `lib` and `proc-macro` crates, with `metadata.visibility` recorded. Prelude and std names never resolve inside the repository unless a local item shadows them.
- 9.5 **Impls and traits.**
  - `impl Trait for Type` emits `implements` from the type to the trait.
  - `trait A: B` emits `extends`.
  - The self type of an impl is resolved through paths, so an impl in another file attaches to the right struct.
- 9.6 **Calls.**
  - Path calls resolve through scopes and paths.
  - `Type::assoc` resolves to the inherent method first. Failing that, if exactly one trait impl in the repository gives `Type` that associated function, it resolves there at medium confidence.
  - `Self::x()` and `self.m()` resolve within the enclosing impl.
  - Typed receivers follow 2.4.
  - A generic or `dyn` receiver resolves `t.render()` to the trait method, with `metadata.dispatch: "trait"`.
  - A name bound by a local `let`, parameter or closure parameter is never resolved to an item.
- 9.7 **References and foreign functions.**
  - Types in signatures, fields, variants, bounds and struct literals, and enum variant paths, emit `references`.
  - Calls to functions in `extern` blocks resolve to their declarations.
  - `#[no_mangle] extern "C"` items carry `metadata.abi`.

Exit criterion: the Rust parity-corpus scenarios for modules, calls, methods, traits and shadowing pass, as does every Rust negative case from 0.6.

Verify: `npx vitest run src/analyzer/rust src/analyzer/parity`.

## Phase 10 - Rust Macros, Compile-Time Includes, and Build Scripts

- 10.1 **`macro_rules!`.** Textual scope follows declaration order and `#[macro_use]`. `#[macro_export]` places a macro at the crate root. An invocation emits `calls` to the `m!` symbol. Tokens inside repository macros are not analyzed.
- 10.2 **Expression-style macros.** Parse the arguments of the built-in expression-style macros (`format!`, the `print` family, `write!`/`writeln!`, `panic!`, the `assert` family, `vec!`, `dbg!`, `matches!`, `todo!`, `unreachable!`) as expressions, plus any macros configured in `rust.macros.expressionLike`.
- 10.3 **Proc macros.** `#[proc_macro_derive(Name)]`, `#[proc_macro_attribute]` and `#[proc_macro]` in an internal proc-macro crate become targets. A matching derive or attribute on an item in a dependent crate emits `references`, with `metadata.mechanism` set to `derive` or `attribute`.
- 10.4 **Compile-time includes.** These go through the shared path evaluator (2.2) with a `file-dir` anchor.
  - `include!` emits `imports` (`include-macro`).
  - `include_str!` and `include_bytes!` emit `consumes` for data files, with `embed: true`.
  - On a template, stylesheet or schema, they emit `usesResource` with `mechanism: "include"`.
  - On any other file in the repository, they emit `consumes` to an `unknown`-format artifact.
  - `concat!`/`env!` paths produce `dynamic-include-path`, except `CARGO_MANIFEST_DIR`, which resolves through the `package-dir` anchor.
- 10.5 **Build scripts.**
  - `cargo:rerun-if-changed=` and `cargo::rerun-if-changed=` lines in `build.rs` emit `reads` (high confidence).
  - An `include!` of an `OUT_DIR` path in the same package links to the build-script package with `dependsOn` (`kind: "build-output"`, medium confidence).

Exit criterion: the macro, include and build-script fixtures pass, `include_*` edges match the `rustc` oracle, and macro-generated items create no false edges.

Verify: `npx vitest run src/analyzer/rust/macros src/analyzer/rust/build`.

## Phase 11 - Data Lineage Parity

The data engine (2.3) gets one catalog with an entry for each language, each matched on resolved APIs.

- 11.1 **JS/TS.** Move the current keyword behavior into catalog entries for `fs` and `fs/promises`, streams, `fetch` of local paths, and the DuckDB/Parquet/Arrow readers already detected. The existing snapshots must not change.
- 11.2 **Python.**
  - **Calls:** `open` (mode-aware, as today), `pathlib.Path` `read_*`/`write_*`/`open`, `json`/`pickle`/`csv`/`yaml`/`tomllib` load and dump on resolved file handles, pandas/polars/pyarrow/duckdb readers and writers, `sqlite3.connect`, `shutil.copy*` (source read, destination write), `np.load`/`np.save`.
  - **Anchors:** `os.path.join`, pathlib `/`, and `__file__`.
  - **Carried over:** the `self.<attr>` directory join from 2.0.0.
- 11.3 **Rust.**
  - **Reads:** `std::fs` `read`/`read_to_string`, `File::open`, `serde_json` reader/writer on resolved files, `csv` `Reader`/`ReaderBuilder::from_path`, Polars `CsvReader`/`ParquetReader`/`scan_*`.
  - **Writes:** `std::fs::write`, `File::create`, `OpenOptions` with `.write`/`.append`/`.create`, `csv::Writer::from_path`, Polars writers.
  - **Reads and writes:** `rusqlite::Connection::open`.
- 11.4 **Path base, the same rule in every language.**
  - An anchored path resolves exactly.
  - A bare relative path is checked against the most specific base first: the package directory for Cargo, or the script's directory and then the project root for Python and JS/TS. Then it is checked against the repository root.
  - If exactly one candidate exists, it is used. Otherwise the first candidate is used.
  - `data.pathBase` overrides the order for every language, and per language under `python`/`rust`/`javascript`.
- 11.5 **Binding flow.** A path value flows through local single-assignment bindings and through `const`/`Final`/`static` items in the repository, in every language.

Exit criterion: the parity scenario "data pipeline write → read" passes in all three languages. The full Python → JSON → Rust → Parquet → TS fixture is one connected path. JS/TS data snapshots are unchanged.

Verify: `npx vitest run src/facts/data src/analyzer/mixed-accuracy src/analyzer/parity`.

## Phase 12 - Mechanism Parity: Events, Registries, State, Callbacks, Loads, Resources

Each item adds per-language catalog entries for one shared engine. The JS/TS catalogs keep their V2 entries.

- 12.1 **Events.**
  - **Python built-ins** (evidence-gated on the receiver's resolved type): `pyee` `EventEmitter` (`on`, `once`, `emit`, `remove_listener`); `blinker` named signals (`signal('ready')` gives the channel `event:blinker#ready`, with `connect`, `send` and `@sig.connect`); Django-style `Signal` (`connect`, `send`, `send_robust`), scoped by the signal's symbol; and `asyncio`/`threading` `Event`, scoped by binding identity (`set` as emit, `wait` as subscribe).
  - **Rust:** event channels are Not applicable for name-keyed channels. Configured method protocols still apply to Rust types whose impls declare both a subscribe and an emit method, which is the same `event-like` rule.
- 12.2 **Registries.**
  - **Python:** literal-key dict registration (`REGISTRY['k'] = Cls`, dict literals of `'k': Cls`); `register('k', Cls)`; decorator registration (`@registry.register('k')`, `@app.route('/path')`, which emits `routesTo` on lookup); entry points (4.5); and parameter-name injection through the existing V2 injection config, which covers pytest fixtures as a documented recipe, not a built-in.
  - **Rust:** `insert`/`entry().or_insert` with a literal key on a static or locally resolvable map, and `get`/`contains_key` lookups.
  - **Attribute registrations**, for Rust attributes and Python decorators: `protocols.registries[].attribute = { name: "tauri::command", key: "fn-name" | { arg: 0 }, scope }`. The lookup side uses the existing method signature form in any language. This covers Tauri commands and route decorators or attributes as configuration recipes.
- 12.3 **Shared state (D8).**
  - **JS/TS:** a module `let` reassigned in a function.
  - **Python:** a module global written through `global` or as `module.NAME = ...` from another module; also `builtins.x = ...`, which maps to the `global` root, as `globalThis` does in JS.
  - **Rust:** `static mut` writes, plus a method catalog for interior-mutable statics. Atomics, `Mutex`/`RwLock` (where `lock()` records a read with `access: "lock"`), `OnceLock`/`LazyLock`, `once_cell`, `lazy_static!` and `thread_local!`.
  - **All three:** configured singletons (`state.singletons`) work, with static field paths only.
- 12.4 **Callbacks.**
  - **Python:** `threading.Thread(target=)`, executor `submit`/`map`, `loop.call_soon`/`run_in_executor`, `atexit.register`, `signal.signal`, `sorted`/`min`/`max`/`map`/`filter` with `key=` or function arguments, and `functools.partial`.
  - **Rust:** a function path passed as an argument to a resolved function (`thread::spawn(worker)`, `iter.map(parse)`), recorded as `passesCallback`.
- 12.5 **Dynamic loads.**
  - **Python:** `importlib.import_module` (including relative imports with `package=`), `__import__`, `importlib.util.spec_from_file_location`, and `runpy.run_module`/`run_path`.
  - **Rust:** `libloading::Library::new` with a literal path, recorded only as an observation.
  - **All languages:** a non-literal specifier produces `dynamic-module-specifier`.
- 12.6 **Resources.**
  - **Python:** `importlib.resources.files(pkg) / 'x.html'` and `joinpath`, `read_text`/`open_text`, `pkgutil.get_data`, and template loaders such as `env.get_template('x.html')` through the existing loader config.
  - **Rust:** the include macros from 10.4.
- 12.7 **Source annotations.** One grammar, the same placement and owner rules, and the same rule that a source annotation overrides config. The comment forms are `//` for JS/TS and Rust (never doc comments) and `#` for Python (never inside strings). The Python and JS-specific annotation collectors (`python-source-annotations.ts`, `source-annotations.ts`) are replaced by the shared engine.
- 12.8 **Not applicable.** Record these in the matrix with their reasons: JS global-object traversal (Python `builtins` is covered under state), `Reflect` metadata, and Rust name-keyed events.

Exit criterion: every mechanism scenario in the parity corpus passes in every language where the matrix says Supported. The V2 negative tests have counterparts in Python and Rust: same key in two registries, same event name on two receivers, a shadowed global.

Verify: `npx vitest run src/facts src/analyzer/parity src/analyzer/*-accuracy`.

## Phase 13 - Accuracy Sweep and Gap Closure

A dedicated phase to close the gaps the parity corpus finds, before boundaries and output are built on top.

- 13.1 Run every corpus and print per-language, per-family metrics: recall, false positives, observations, and runtime on the synthetic repositories.
- 13.2 For every gap, either fix the front end or engine, or move the matrix cell to Not applicable or Deferred with a reason. Every Deferred cell needs explicit approval and a tracking issue.
- 13.3 Run all three languages against real-world repositories:
  - **JS/TS:** reuse the V2 set.
  - **Python:** a src-layout library, a Django-style app, a data pipeline with pandas, and a namespace-package monorepo.
  - **Rust:** a multi-crate workspace, a `wasm-pack` app, a maturin/PyO3 package, a Tauri app, and a proc-macro crate with its consumer.

  Record crashes, oracle mismatches and runtime. Fix every crash and every oracle mismatch.

Exit criterion: the budgets are met for every language and family. The parity matrix has no unapproved Deferred cells.

Verify: `npm run test:accuracy` (new script that prints the per-language metrics table).

## Phase 14 - Cross-Language Boundaries

- 14.1 **Binding index.** Each front end publishes the bindings it produces and consumes. A consumer import that its own front end cannot resolve to a repository file is checked against the index before it is reported as unresolved.
- 14.2 **`wasm-bindgen`.** This applies only when the crate depends on `wasm-bindgen`.
  - **Rust to JS.** `#[wasm_bindgen]` exports are recorded, with `js_name` renames applied. JS/TS imports of the wasm-pack output (default `<crate>/pkg/<name>.js`, or `rust.bindings[].outDir`) or of the package name `packageName` emit `calls` to the Rust symbol: high confidence when configured, medium when inferred from defaults.
  - **JS to Rust.** `#[wasm_bindgen(module = "/js/x.js")]` (relative to the crate root) and `raw_module` (relative to the file) emit `imports` from the Rust file to the JS file (`wasm-bindgen-module`), plus calls to the JS symbols.
- 14.3 **PyO3 and maturin.** This applies only when the crate depends on `pyo3`.
  - The module name comes from `#[pymodule]`, `#[pyo3(name)]` or `[tool.maturin] module-name`.
  - Members come from `add_function(wrap_pyfunction!(..))`, `add_class::<T>()` and `#[pymodule_export]`.
  - Python imports resolve through the index and emit `calls` to the Rust symbol.
  - In mixed projects, the maturin `python-source` directory is also an import root (4.2).
- 14.4 **napi-rs.** This applies only when the crate depends on `napi`/`napi-derive`. `#[napi]` exports are converted to camelCase, with `js_name` applied. The consumer is the sibling `package.json` package or `rust.bindings[]`. Default confidence is medium.
- 14.5 **Process execution (`executes`), the same in every language.** A literal argument list that runs a script in the repository emits `executes` from the owner to that script:
  - JS: `child_process` `spawn`/`exec`/`execFile`.
  - Python: `subprocess.run`/`Popen`/`check_call`, `os.system`.
  - Rust: `std::process::Command::new(..).arg(..)`.

  The recognized forms are `python scripts/x.py`, `node scripts/x.js`, `cargo run -p crate`/`--bin`, `npm run <script>` (resolved through `package.json` scripts) and a direct script path. A non-literal command produces an observation. `package.json` scripts, Makefile targets and `[project.scripts]` reuse the same command resolver, at `evidence: "manifest"`.

- 14.6 **Unresolved bindings.** A consumer that matches a binding's specifier but names something the producer does not export gets `unresolved-binding`. A same-named module without the binding dependency gets no edge.

Exit criterion: the WASM, PyO3, napi-rs, Tauri-recipe and process-execution fixtures each form one navigable path. Every negative fixture (no binding dependency, a same-named module) produces no edge.

Verify: `npx vitest run src/analyzer/bindings src/analyzer/mixed-accuracy`.

## Phase 15 - Output, Queries, Configuration, and Documentation

- 15.1 **Markdown.**
  - Add one `## Packages` section covering npm, Python and Cargo, grouped by manifest, with each package's target, roots and internal `dependsOn` edges.
  - Every file entry in `File Connections` shows its language. Rust files also show `Declares modules`/`Declared by`.
  - Add `## Language Boundaries` for bindings and executions.
  - No section is specific to one language. Empty sections are omitted.
- 15.2 **Paths and queries.**
  - `declaresModule`, `dependsOn`, `packageRoot` and `executes` join the `code` family.
  - Path ranking prefers `calls`/`imports` over `declaresModule`/`packageRoot`. The degree bound of 50 still applies.
  - Add `balk2 query --language <list>`, and allow `--focus package:...`.
- 15.3 **Configuration (`.balk2.json` version 3).**

  ```json
  {
    "version": 3,
    "include": { "tests": true },
    "data": { "pathBase": ["package", "file", "repository"] },
    "python": {
      "roots": ["src", "."],
      "identityDecorators": ["my_cache"]
    },
    "rust": {
      "macros": { "expressionLike": ["log_info"] },
      "bindings": [
        {
          "kind": "wasm-bindgen",
          "crate": "core",
          "outDir": "web/pkg",
          "packageName": "@app/core"
        },
        { "kind": "pyo3", "crate": "fastpath", "pythonModule": "app._fastpath" }
      ]
    },
    "protocols": {
      "events": {
        "methods": [
          {
            "method": "publish",
            "direction": "emit",
            "eventArg": 0,
            "languages": ["python", "typescript"]
          }
        ]
      }
    }
  }
  ```

  Every protocol entry accepts an optional `languages` filter. When it is omitted, the entry applies to every language whose syntax supports the form. Version 2 config files stay valid. The schema in `schemas/balk2.schema.json` is updated, and the loader reports unknown keys.

- 15.4 **Documentation.**
  - `docs/v3/languages/javascript-typescript.md`, `python.md` and `rust.md` all follow the same outline: recognized forms, resolution rules, mechanisms, limits, and Not applicable items.
  - Also write `docs/v3/language-parity.md`, `docs/v3/connection-map-schema.md`, `docs/v3/python-changes.md` and `docs/v3/phase-0-contract.md`.
  - The README has a "Supported languages" table that links the parity matrix, plus quick starts for each language.

- 15.5 **pre-commit framework hooks.** Add `.pre-commit-hooks.yaml` at the balk2 repository root, so teams that use the [pre-commit](https://pre-commit.com) framework (common in Python and Rust projects) can run Balk2 without adding a `package.json`. pre-commit installs a private Node environment for `language: node` hooks.
  - Provide two hook ids. `balk2` regenerates the map. Under pre-commit, a hook that changes files fails the commit once, and the user stages the map and commits again. `balk2-check` fails when the map is out of date and changes nothing. It runs `balk2 check` with `pass_filenames: false` and `always_run: true`.
  - Confirm how pre-commit installs a `language: node` hook repository (it packs and installs the repository at the pinned `rev`, so `dist/` must be built at install time or the hook must install the published npm package through `additional_dependencies`). Choose the approach that does not require committing `dist/`, and document it.
  - `balk2 install` detects a pre-commit-managed `.git/hooks/pre-commit` (the generated script names pre-commit) and does not append to it. It prints the `.pre-commit-config.yaml` snippet to use instead.
  - The README gains a pre-commit section that shows a `.pre-commit-config.yaml` entry pinned to a release tag.

Exit criterion: maps for a JS/TS-only, a Python-only, a Rust-only and a mixed repository each read clearly with the same section structure. Every documented config example validates. `pre-commit try-repo` runs both hook ids successfully against a fixture repository.

Verify: `npx vitest run src/renderer src/query src/config && npm run verify`.

## Phase 16 - Verification and Release

- 16.1 **Oracle jobs.** A new `ts-oracle` job compares JS/TS module edges against `ts.resolveModuleName` on the fixtures, so JS/TS is held to the same explicit check as the other two. The `python-oracle` job uses `ast` and `importlib.util.find_spec`. The `rust-oracle` job uses `rustc` dep-info files. All three are required CI checks.
- 16.2 **Corpus gates.** The parity corpus, the per-language corpora and the mixed corpus are required. Canonical snapshots are added under `test/snapshots/`, with names like `python-*.txt`, `rust-*.txt` and `parity-*.txt`.
- 16.3 **False-positive mutation tests.** Each case has a counterpart in all three languages:
  - same-named functions
  - the same method name on two types called through an untyped receiver
  - the same key in two registries
  - the same event name on two receivers
  - a shadowed import or global
  - a module named like a binding but without the binding dependency
- 16.4 **Determinism.** Output is byte-identical across repeated runs on Linux and Windows, for every language.
- 16.5 **Package checks.** `npm run test:package` verifies `PythonAnalyzer`, `RustAnalyzer` and the v3 types under ESM and CJS, checks that the TOML dependency resolves from the tarball, and runs the CLI on a Python fixture, a Rust fixture and a mixed fixture from a packed install.
- 16.5a **pre-commit.** A CI job runs `pre-commit try-repo <checkout> balk2 --all-files` and `balk2-check` against a Python fixture repository that has no `package.json`, on Linux and Windows.
- 16.6 **Performance.** The synthetic repositories in each language meet the shared budget. A repository with built `target/`, `.venv` and `node_modules` directories takes about the same time to scan as one without them.
- 16.7 **Release.**
  - Publish `3.0.0-rc` and test it against clean fixture projects in all three languages, then promote.
  - The release notes list: schema v3, every new union value (as in V2's Compatibility section), manifests no longer being artifacts, the new excludes, the D8 state edges for JS/TS, the Python output changes (linked to `python-changes.md`), the deprecation of `Analyzer.analyzeFile`, and config version 3.

Exit criterion: all three oracles, every corpus, the mutation tests, the determinism checks, the package tests and the performance budgets pass on Node 18/20/22, on Linux and Windows.

Verify: `npm run verify && npm run test:accuracy` plus the `ts-oracle`, `python-oracle` and `rust-oracle` CI jobs.

## Delivery Order

1. **Phase 0–2: contracts, a language-neutral pipeline, and the facts layer and engines, with JS/TS moved at zero diff.** These come first because they make parity structural. Nothing language-specific is built until the engines exist.
2. **Phase 3–5: the Python front end.** It replaces the regex analyzer and is validated against CPython. Python goes first because it already has users, and because it proves the engines on a second front end before Rust arrives.
3. **Phase 6–10: the Rust front end, Cargo, the module tree, names and macros.** These are validated against `rustc`.
4. **Phase 11–13: data and mechanism parity for all three languages, then a gap-closure sweep with metrics.**
5. **Phase 14–16: cross-language boundaries, output and configuration, and release gates.**

Suggested intermediate releases:

- `3.0.0-alpha.1` after Phase 5: Python at parity for modules, calls and types.
- `3.0.0-alpha.2` after Phase 10: Rust structure.
- `3.0.0-beta` after Phase 13: mechanism parity.

## Explicitly Out of Scope for V3

- Type inference beyond the local type rules in 2.4 for Python and Rust. That excludes inference through generics, auto-deref chains, method results in chains (`a.b().c()`), and Python flow-sensitive narrowing.
- Running a type checker for Python (mypy or pyright) or Rust (`rust-analyzer`) at generate time.
- Expanding macros or decorators, beyond the identity-decorator catalog.
- Evaluating `cfg`, features, `sys.version_info` or `TYPE_CHECKING`.
- The internals of external packages (`node_modules`, `site-packages`, crates.io).
- C/C++ analysis across FFI boundaries.
- Distribution channels other than npm and the pre-commit hook (standalone binaries on GitHub Releases, PyPI wheels, `cargo-binstall`). Revisit after 3.0.0, based on demand from Python and Rust users.
- Data flow through channels or queues, and general interprocedural data flow.

## Definition of Done

V3 is complete when:

- JS/TS, Python and Rust each produce packages, module edges checked against their oracle, imports and re-exports, exports, symbols, inheritance and implementation, references, and calls resolved through bindings and local types. All three use one graph contract and one confidence and evidence vocabulary.
- Events, registries, state, callbacks, dynamic loads, resources, data lineage and source annotations are produced by shared engines for every language where the parity matrix says Supported. Every Not applicable cell has a reason based on language semantics.
- The parity corpus produces the same normalized graph shape in all three languages, and the per-language accuracy metrics meet the same budgets.
- WASM, PyO3, napi-rs, attribute registrations and process execution connect the languages, but only when both sides provide evidence.
- Dynamic or ambiguous constructs in any language are visible as observations or diagnostics, never as guessed edges.
- Output is deterministic on Linux and Windows. The packed `3.0.0` tarball passes every consumer, oracle, corpus and determinism check.
