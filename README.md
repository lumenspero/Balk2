<p align="center">
  <img src="assets/molly.png" alt="Balk2 — Repository Connection Map for AI Agents" width="100%">
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
  - **JavaScript & TypeScript**: `.js`, `.jsx`, `.ts`, `.tsx`, `.mjs`, `.cjs`
  - **Python**: `.py`
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

---

## CLI Commands & Options

### `balk2 [generate]`

Scans the repository, builds the connection graph, and writes `connection-map.json` and `connection-map.md`.

```bash
# Default generation
npx @lumenspero/balk2

# Custom output directory or base filename
npx @lumenspero/balk2 --output build/connection-map
npx @lumenspero/balk2 -o custom-dir/
```

### `balk2 install`

Installs a Git `pre-commit` hook in `.git/hooks/pre-commit`. The hook automatically regenerates the connection map and stages updated artifacts whenever you make a commit.

```bash
npx @lumenspero/balk2 install
```

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

---

## Configuration (`.balk2.json`)

You can optionally place a `.balk2.json` configuration file in the root of your repository to customize include/exclude rules, output locations, and explicit data pipeline rules.

```json
{
  "include": ["src/**", "scripts/**", "data/**"],
  "exclude": ["node_modules/**", "dist/**", "build/**", "coverage/**"],
  "output": "connection-map",
  "data": {
    "extensions": [
      ".json",
      ".jsonl",
      ".csv",
      ".tsv",
      ".parquet",
      ".yaml",
      ".yml",
      ".toml",
      ".xml",
      ".sqlite"
    ],
    "lineage": [
      {
        "producer": "scripts/collect.py",
        "output": "data/raw.json"
      },
      {
        "producer": "scripts/build_parquet.py",
        "input": "data/raw.json",
        "output": "data/titles.parquet"
      },
      {
        "consumer": "src/data/loadTitles.ts",
        "input": "data/titles.parquet"
      }
    ]
  }
}
```

---

## Programmatic API

Balk2 provides a complete TypeScript / JavaScript API for programmatic usage:

```typescript
import {
  ConnectionGraph,
  JsTsAnalyzer,
  PythonAnalyzer,
  registerDataArtifacts,
  renderMarkdown,
  serializeConnectionMap,
  generateConnectionMap,
} from '@lumenspero/balk2';

// High-level API: Generate map for a directory
const { jsonPath, mdPath, map } = generateConnectionMap({
  cwd: './my-repo',
  output: 'connection-map',
});

// Low-level API: Custom graph construction
const graph = new ConnectionGraph();
const jsAnalyzer = new JsTsAnalyzer();
const pyAnalyzer = new PythonAnalyzer();

// Analyze source files
pyAnalyzer.analyzeFile('scripts/collect.py', pythonCode, graph);
jsAnalyzer.analyzeFile('src/main.ts', tsCode, graph);

// Build canonical ConnectionMap object
const mapObj = graph.build({
  commit: 'a81f32c',
  generatedAt: new Date().toISOString(),
});

// Render artifacts
const markdownString = renderMarkdown(mapObj);
const jsonString = serializeConnectionMap(mapObj);
```

The package root is the supported programmatic entry point. Balk2 ships both ESM and CommonJS runtime entries with matching TypeScript declarations:

```javascript
// ESM
import { ConnectionGraph } from '@lumenspero/balk2';

// CommonJS
const { ConnectionGraph } = require('@lumenspero/balk2');
```

Direct imports from `@lumenspero/balk2/dist/*` are not part of the public API.

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
