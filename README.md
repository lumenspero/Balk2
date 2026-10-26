<p align="center">
  <img src="assets/molly-3.png" alt="Balk2 — Repository Connection Map for AI Agents" width="100%">
</p>

# Balk2 — Repository Connection Map

[![npm version](https://img.shields.io/npm/v/@lumenspero/balk2.svg?v=1)](https://www.npmjs.com/package/@lumenspero/balk2)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/@lumenspero/balk2.svg?v=1)](https://nodejs.org)

**Balk2** generates compact, deterministic **Repository Connection Maps** designed specifically for AI-assisted interconnected code changes.

When building or modifying complex features that span multiple files, modules, directories, programming languages, or data pipeline artifacts, Balk2 answers:

> _"If I change this file, function, or data artifact, what other repository components are structurally connected to it and may need to be inspected?"_

---

## Output Artifacts

Balk2 scans your codebase and generates two canonical artifacts:

1. **`connection-map.md`** — A compact, human-readable Markdown summary designed to be provided directly to AI coding assistants (Claude, Gemini, ChatGPT, Cursor, Antigravity) as context.
2. **`connection-map.json`** — The canonical machine-readable graph representation for tooling, scripts, and future integrations.

---

## Features

- **Multi-Language Static Analysis**:
  - **JavaScript & TypeScript**: `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`, `.mts`, `.cts`
  - **Python**: `.py`
  - **Rust** (3.0.0 and later): `.rs`, with `Cargo.toml` packages

See [Supported languages](#supported-languages) for what each language recognizes.

- **Code & Symbol Relationships**:
  - Module imports & exports (`imports`, `importedBy`, `exports`)
  - Function & method call graphs (`calls`, `calledBy`)
  - Class inheritance (`extends`) & interface implementation (`implements`)
- **Data Artifact & Pipeline Lineage**:
  - Auto-recognizes **JSON**, **JSONL/NDJSON**, **CSV**, **TSV**, **Parquet**, **YAML**, **TOML**, **XML**, **SQLite** database files.
  - Automatically traces file read/write operations (`generates`, `generatedBy`, `consumes`, `consumedBy`, `reads`).
- **Configuration & Explicit Lineage (`.balk2.json`)**:
  - Declare custom path filters (`include`, `exclude`) and output targets.
  - Declare explicit pipeline lineage for dynamic data paths.
- **Git Integration & Automation**:
  - One-command pre-commit Git hook setup (`npx balk2 install`).
  - Automatically records Git commit hash metadata (`git rev-parse --short HEAD`).
- **Focused Queries** (`balk2 query`): relationships around one file or node, filtered by family, confidence and node kind, with bounded traversal.
- **CI Diagnostics** (`--fail-on`): fail a `generate` or `check` run on any diagnostic kind you select, such as syntax errors, ignored configuration, or unresolved references.

---

## Quick Start

### Installation

Install globally or as a project devDependency:

```bash
# Global installation
npm install -g @lumenspero/balk2

# Or project-level dev dependency
npm install --save-dev @lumenspero/balk2
```

### Basic Usage

Run `@lumenspero/balk2` inside any repository:

```bash
npx @lumenspero/balk2
```

This generates:

- `connection-map.json`
- `connection-map.md`

### Quick starts by language

The same command works in every language. Balk2 reads each supported language in a repository, so you do
not switch modes.

```bash
npx @lumenspero/balk2
```

- **JavaScript and TypeScript.** Run the command at the repository root. If the project has a
  `tsconfig.json`, Balk2 uses its options for module resolution. Otherwise it uses Node 16 defaults.
- **Python.** Run the command at the repository root. Imports and calls need no configuration. Project
  conventions such as pytest fixtures and decorator registries are set under `protocols`; see
  [python.md](docs/v3/languages/python.md).
- **Rust (3.0.0 and later).** Run the command at the repository root. Each `Cargo.toml` package is read.
  The published 2.0.1 package does not read Rust, so Rust needs 3.0.0 or later.

If a binding crate uses a name other than the default, set it under `rust.bindings`:

```json
{
  "version": 3,
  "rust": {
    "bindings": [{ "kind": "pyo3", "crate": "fastpath", "pythonModule": "app.native" }]
  }
}
```

### Supported languages

| Language                | Source files                                                 | Package manifests             | What is read                                                                                                                                                      | Reference                                                              |
| ----------------------- | ------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| JavaScript & TypeScript | `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts` | `package.json`                | Imports and re-exports, calls, inheritance, events, registries, callbacks, module-level state, data lineage, process execution                                    | [javascript-typescript.md](docs/v3/languages/javascript-typescript.md) |
| Python                  | `.py`                                                        | `pyproject.toml`, `setup.cfg` | Imports, calls, inheritance, events (pyee, blinker, Django, threading), registries, callbacks, shared state, resources, dynamic loads, PyO3 consumers, subprocess | [python.md](docs/v3/languages/python.md)                               |
| Rust (3.0.0 and later)  | `.rs`                                                        | `Cargo.toml`                  | Modules and imports, calls, traits, registries, shared state, callbacks, native libraries, wasm-bindgen, napi and PyO3 bindings, process execution                | [rust.md](docs/v3/languages/rust.md)                                   |

The status of each mechanism in each language is in
[language-parity.md](docs/v3/language-parity.md).

---

## CLI Commands & Options

### `balk2 [generate]`

Scans the repository, builds the connection graph, and writes `connection-map.json` and `connection-map.md`.

```bash
# Default generation
npx @lumenspero/balk2

# Output directory, or a .json or .md file path
npx @lumenspero/balk2 --output build/connection-map
npx @lumenspero/balk2 -o custom-dir/
```

### `balk2 install`

Installs a Git `pre-commit` hook in `.git/hooks/pre-commit`. The hook automatically regenerates the connection map and stages updated artifacts whenever you make a commit.

```bash
npx @lumenspero/balk2 install
```

If the repository already uses the [pre-commit](#pre-commit) framework, `install` does not change its hook. It prints the configuration to add instead.

### Pre-commit

Balk2 provides [pre-commit](https://pre-commit.com) hooks, so a repository can run it without a `package.json`. Add this to `.pre-commit-config.yaml`:

```yaml
repos:
  - repo: https://github.com/lumenspero/Balk2
    # Use a release that includes .pre-commit-hooks.yaml (3.0.0 or later).
    rev: <release tag>
    hooks:
      - id: balk2 # regenerates connection-map.json and connection-map.md
      - id: balk2-check # fails when the map is out of date; changes no files
```

Then run `pre-commit install`. To try the hooks without committing, run `pre-commit run balk2 --all-files` or `pre-commit run balk2-check --all-files`.

**Requirements.** The hooks run the Balk2 package through `npx`, using the Node and npm already on the machine. pre-commit does not install Node for them. Node 18 or later and npm must be on the PATH.

**Behavior.**

- `balk2` regenerates the map. The map records the commit it was generated from and the time, so it changes on most commits. When it changes, the commit stops once. Stage `connection-map.json` and `connection-map.md`, then commit again.
- `balk2-check` fails when `connection-map.json` does not match the repository. It changes no files, so it suits a guard that must not modify anything, such as a CI step.
- The hooks run the package version pinned in `.pre-commit-hooks.yaml`. Update the pin with the release.

### `balk2 uninstall`

Removes the installed Balk2 Git pre-commit hook.

```bash
npx @lumenspero/balk2 uninstall
```

### `balk2 check`

Validates configuration and checks whether `connection-map.json` is up to date with current repository state. Exits with code `0` if current, or `1` if out of date. Useful for CI checks.

```bash
npx @lumenspero/balk2 check
```

With `--fail-on`, `check` also exits `1` when a selected diagnostic is found (see below).

### `balk2 query`

Prints relationships from `connection-map.json` without regenerating it. Run `balk2` first.

```bash
# Relationships touching one file: one hop, medium confidence and above
npx @lumenspero/balk2 query --focus src/main.ts

# Two hops out, following code and data edges, including low-confidence guesses
npx @lumenspero/balk2 query --focus scripts/collect.py --depth 2 --traverse code,data --min-confidence low

# Only event relationships, as JSON
npx @lumenspero/balk2 query --family events --json
```

| Option                                | Meaning                                                                                                                                                                                            |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--focus <file or node>`              | Limit output to the neighborhood of a file path or node id                                                                                                                                         |
| `--depth <n>`                         | Hops from the focus to follow (default `1`)                                                                                                                                                        |
| `--traverse <list>`                   | Families followed outward from the focus (default `code`). Other families are listed for each node reached, but not expanded                                                                       |
| `--max-degree <n>`, `--no-max-degree` | Nodes with more than `n` relationships are listed but not expanded (default `50`)                                                                                                                  |
| `--family <list>`                     | Keep only these families: `code`, `events`, `data`, `registry`, `metadata`, `resources`, `state`                                                                                                   |
| `--min-confidence <level>`            | `high`, `medium` or `low` (default `medium`)                                                                                                                                                       |
| `--node-kind <list>`                  | Keep relationships whose two ends are these node kinds: `file`, `symbol`, `artifact`, `event-channel`, `unresolved-reference`, `registry-key`, `state-path`, `metadata-key`, `resource`, `package` |
| `--language <list>`                   | Keep relationships whose endpoints are in these languages: `javascript`, `typescript`, `python`, `rust`. Language-neutral nodes are not excluded                                                   |
| `--limit <n>`, `--no-limit`           | Most relationships to print (default `200`)                                                                                                                                                        |
| `--json`                              | Print JSON instead of text lines                                                                                                                                                                   |
| `-o, --output <path>`                 | Where `connection-map.json` was written                                                                                                                                                            |

Exit codes: `0` on success, `1` when the map is missing or the focus matches nothing, `2` for bad arguments.

### Failing CI on diagnostics (`--fail-on`)

`generate` and `check` report these kinds of diagnostic:

- `syntax`: a source file did not parse.
- `config`: an entry in `.balk2.json` was ignored.
- `manifest`, `unreachable-module`, `module-conflict` and `shadowed-module`: a package manifest or module could not be used as declared.
- One kind per unresolved reference, named by its reason: `ambiguous-global`, `dynamic-event-name`, `unknown-event-receiver`, `dynamic-registry-key`, `unknown-registry-receiver`, `ambiguous-registry`, `dynamic-state-path`, `dynamic-module-specifier`, `unresolved-callback`, `unresolved-metadata-key`, `dynamic-resource-specifier`, `unresolved-module-path`, `macro-generated-item`, `ambiguous-star-import`, `dynamic-include-path`, `unresolved-binding` and `dynamic-command`.

Pass `--fail-on` with the kinds that should fail the run:

```bash
npx @lumenspero/balk2 generate --fail-on syntax,config,ambiguous-global
```

Only the selected diagnostics are printed to stderr, in a fixed order, followed by a summary. The run exits `1` when any selected diagnostic is found, and outputs are still written. Unknown kinds exit `2` and list the valid ones. Without `--fail-on`, output is unchanged.

---

## Configuration (`.balk2.json`)

Balk2 works without a configuration file. To change what it scans or where it writes, add a `.balk2.json` to the root of your repository. The minimal file sets the output location, which is also the default:

```json
{
  "output": "connection-map"
}
```

Every key is optional. The keys most projects use are:

- **`include`**: glob patterns for the files to scan, such as `["src/**", "scripts/**"]`. When omitted, every file is considered.
- **`exclude`**: glob patterns for files to skip, applied after `include`, such as `["**/*.generated.ts"]`. Balk2 always skips `node_modules`, `dist`, `build`, `coverage`, `.git`, `.github`, `.idea`, `.vscode`, and the default `connection-map` files. It also skips generated directories: `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`, `.nox` and `*.egg-info`; a `target` directory beside a `Cargo.toml`; and a `.venv` or `venv` directory that contains `pyvenv.cfg`.
- **`output`**: where `generate` writes `connection-map.json` and `connection-map.md`. Use an existing directory to write both files inside it, or a path ending in `.json` or `.md`. Any other value falls back to the repository root.
- **`data.lineage`**: explicit links that Balk2 cannot infer from the code, such as a script that writes a data file which another file reads. Each entry names a `producer` and its `output`, or a `consumer` and its `input`. Both paths must exist in the repository, or Balk2 reports a `config` diagnostic. Add entries only for links your repository actually has.

A fuller example:

```json
{
  "include": ["src/**", "scripts/**", "data/**"],
  "exclude": ["**/*.test.ts"],
  "output": "docs/connection-map.json",
  "data": {
    "lineage": [
      {
        "producer": "scripts/export_report.py",
        "output": "data/report.json"
      },
      {
        "consumer": "src/report/render.ts",
        "input": "data/report.json"
      }
    ]
  }
}
```

Edit the paths to match your repository. A lineage path that does not exist is reported as a `config` diagnostic.

---

### Other configuration sections

Besides `include`, `exclude`, `output` and `data`, `.balk2.json` has sections for `globals`, `protocols` (events, registries, loaders, callbacks, metadata and resources), `state`, `annotations`, `python` and `rust`. The Python and Rust sections are described in the language documents, [python.md](docs/v3/languages/python.md) and [rust.md](docs/v3/languages/rust.md). The others are described in [`docs/v2`](docs/v2). The whole file is checked against the published JSON Schema, which ships in the package at `dist/balk2.schema.json`. Reference it for editor completion and validation:

```json
{
  "$schema": "./node_modules/@lumenspero/balk2/dist/balk2.schema.json"
}
```

Entries that cannot be used are reported as `config` diagnostics and ignored, so a mistyped setting does not silently do nothing.

Set a top-level `"version"` to `2` or `3`. The key is optional. Version 3 is the current format. Version 2 files are read unchanged. Any other value is reported as a config diagnostic.

Version 3 adds two things to protocol entries and to the Rust section:

- **`languages`** on a protocol entry limits it to the listed families, `javascript`, `typescript`, `python` or `rust`. An entry without it applies to every language whose syntax supports the form. An entry tagged for a language that does not read it is reported and ignored. For example, configured event methods are read for JavaScript and TypeScript only:

```json
{
  "version": 3,
  "protocols": {
    "events": {
      "methods": [
        { "method": "publish", "direction": "emit", "eventArg": 0, "languages": ["typescript"] }
      ]
    }
  }
}
```

- **`rust`** holds two settings. `macros.expressionLike` lists macro names whose arguments are code, so calls inside them are found. `bindings` overrides what the binding engine infers for a crate, such as the output directory of a wasm-bindgen package or the Python module of a PyO3 crate:

```json
{
  "version": 3,
  "rust": {
    "macros": { "expressionLike": ["log_info"] },
    "bindings": [
      { "kind": "wasm-bindgen", "crate": "core", "outDir": "web/pkg" },
      { "kind": "napi", "crate": "native", "packageName": "@scope/native" }
    ]
  }
}
```

---

## Programmatic API

For a repository, call `generateConnectionMap`. It scans the repository with the same configuration as the CLI, writes `connection-map.json` and `connection-map.md`, and returns the map and the diagnostics:

```typescript
import { generateConnectionMap } from '@lumenspero/balk2';

const { jsonPath, mdPath, map, diagnostics } = generateConnectionMap({
  cwd: './my-repo',
  output: 'connection-map',
});
```

Options: `cwd` is the repository root (default: the current directory). `output` is a directory, or a path ending in `.json` or `.md` (default: `connection-map`). `timestamp` replaces the generation time, for tests.

To analyze one file into a graph, use the per-file analyzers. They see only that file, plus the files listed in `knownFiles` and the files readable under `rootDir` (both are optional options on `analyzeFile`):

```typescript
import {
  ConnectionGraph,
  JsTsAnalyzer,
  renderMarkdown,
  serializeConnectionMap,
} from '@lumenspero/balk2';
import * as fs from 'node:fs';

const graph = new ConnectionGraph();
new JsTsAnalyzer().analyzeFile('src/main.ts', fs.readFileSync('src/main.ts', 'utf8'), graph);

const map = graph.build({ commit: 'a81f32c', generatedAt: new Date().toISOString() });
const markdown = renderMarkdown(map);
const json = serializeConnectionMap(map);
```

`PythonAnalyzer` is deprecated. Its `analyzeFile` still works for a single Python file, but for a Python repository use `generateConnectionMap`, which resolves imports across files.

The package root is the supported programmatic entry point. Balk2 ships both ESM and CommonJS runtime entries with matching TypeScript declarations:

```javascript
// ESM
import { ConnectionGraph } from '@lumenspero/balk2';

// CommonJS
const { ConnectionGraph } = require('@lumenspero/balk2');
```

Direct imports from `@lumenspero/balk2/dist/*` are not part of the public API.

The `ConnectionMap` type is version 3. `deserializeConnectionMap` still reads versions 1 and 2. Consumers that switch over the node, relationship, evidence or reason unions must handle the values V3 added; see [`docs/v3/connection-map-schema.md`](docs/v3/connection-map-schema.md). See [CHANGELOG.md](CHANGELOG.md) for the migration.

---

## Development & Testing

```bash
# Clone repository
git clone https://github.com/lumenspero/Balk2.git
cd Balk2

# Install dependencies
npm install

# Run type check
npm run typecheck

# Run test suite (Vitest)
npm test

# Run linter & formatter checks
npm run lint
npm run format:check

# Build project (TypeScript compilation to dist/)
npm run build
```

---

## Sponsor

[![Sponsor via Stripe](https://img.shields.io/badge/Sponsor%20via-Stripe-6772e5?style=for-the-badge&logo=stripe&logoColor=white)](https://donate.stripe.com/4gM3cv4L14y03Ql18k0Fi04)

---

## License

[MIT License](LICENSE) © 2026

[def]: https://donate.stripe.com/4gM3cv4L14y03Ql18k0Fi04
