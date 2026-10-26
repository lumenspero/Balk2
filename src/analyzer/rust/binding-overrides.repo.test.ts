import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Balk2Config } from '../../config/balk2-config.js';
import { buildConnectionGraph, buildConnectionGraphDetailed } from '../../cli/build-graph.js';
import type { ConnectionGraph } from '../../graph.js';

/** Configured binding overrides (V3 Phase 15.3d), tested on throwaway repositories. */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-overrides-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

function mechanismEdges(
  graph: ConnectionGraph,
  mechanism: string,
): ReturnType<ConnectionGraph['getRelationships']> {
  return graph
    .getRelationships()
    .filter((r) => (r.metadata as Record<string, unknown> | undefined)?.mechanism === mechanism);
}

const WASM_CARGO = `[package]
name = "core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
`;

const WASM_EXPORTS = `use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn search(query: &str) -> String {
    query.to_string()
}
`;

const NAPI_CARGO = `[package]
name = "core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = "2"
napi-derive = "2"
`;

const NAPI_EXPORTS = `use napi_derive::napi;

#[napi]
pub fn parse_text(text: String) -> String {
    text
}
`;

const PYO3_CARGO = `[package]
name = "fastpath"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
pyo3 = "0.22"
`;

const PYO3_MODULE = `use pyo3::prelude::*;

#[pyfunction]
fn parse(text: &str) -> usize {
    text.len()
}

#[pymodule]
fn _fastpath(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(parse, m)?)?;
    Ok(())
}
`;

describe('wasm-bindgen outDir override', () => {
  const config: Balk2Config = {
    version: 3,
    rust: { bindings: [{ kind: 'wasm-bindgen', crate: 'core', outDir: 'custom' }] },
  } as Balk2Config;

  it('binds the JS import at the configured output directory, with high confidence', () => {
    const root = repoWith({
      'Cargo.toml': WASM_CARGO,
      'src/lib.rs': WASM_EXPORTS,
      'web/src/search.ts': `import { search } from '../../custom/core.js';\nexport const x = search;\n`,
    });
    const edges = mechanismEdges(buildConnectionGraph(root, config), 'wasm-bindgen');
    expect(edges.map((e) => [e.type, e.from, e.to, e.confidence])).toEqual([
      ['calls', 'web/src/search.ts', 'src/lib.rs:search', 'high'],
    ]);
  });

  it('does not bind the default pkg path once outDir is configured', () => {
    const root = repoWith({
      'Cargo.toml': WASM_CARGO,
      'src/lib.rs': WASM_EXPORTS,
      'web/src/search.ts': `import { search } from '../../pkg/core.js';\nexport const x = search;\n`,
    });
    expect(mechanismEdges(buildConnectionGraph(root, config), 'wasm-bindgen')).toHaveLength(0);
  });
});

describe('napi packageName override', () => {
  const config: Balk2Config = {
    version: 3,
    rust: { bindings: [{ kind: 'napi', crate: 'core', packageName: '@other/core' }] },
  } as Balk2Config;

  it('binds the configured package name, with high confidence', () => {
    const root = repoWith({
      'Cargo.toml': NAPI_CARGO,
      'package.json': `{ "name": "@app/core", "main": "index.js" }\n`,
      'src/lib.rs': NAPI_EXPORTS,
      'web/src/run.ts': `import { parseText } from '@other/core';\nexport const x = parseText;\n`,
    });
    const edges = mechanismEdges(buildConnectionGraph(root, config), 'napi');
    expect(edges.map((e) => [e.from, e.to, e.confidence])).toEqual([
      ['web/src/run.ts', 'src/lib.rs:parse_text', 'high'],
    ]);
  });

  it('does not bind the package.json name once packageName is configured', () => {
    const root = repoWith({
      'Cargo.toml': NAPI_CARGO,
      'package.json': `{ "name": "@app/core", "main": "index.js" }\n`,
      'src/lib.rs': NAPI_EXPORTS,
      'web/src/run.ts': `import { parseText } from '@app/core';\nexport const x = parseText;\n`,
    });
    expect(mechanismEdges(buildConnectionGraph(root, config), 'napi')).toHaveLength(0);
  });
});

describe('pyo3 pythonModule override', () => {
  const config: Balk2Config = {
    version: 3,
    rust: { bindings: [{ kind: 'pyo3', crate: 'fastpath', pythonModule: 'custom_mod' }] },
  } as Balk2Config;

  it('binds the configured Python module name, with high confidence', () => {
    const root = repoWith({
      'Cargo.toml': PYO3_CARGO,
      'src/lib.rs': PYO3_MODULE,
      'scripts/run.py': `from custom_mod import parse\n\nprint(parse("x"))\n`,
    });
    const edges = mechanismEdges(buildConnectionGraph(root, config), 'pyo3');
    expect(edges.map((e) => [e.from, e.to, e.confidence])).toEqual([
      ['scripts/run.py', 'src/lib.rs:parse', 'high'],
    ]);
  });

  it('does not bind the #[pymodule] name once pythonModule is configured', () => {
    const root = repoWith({
      'Cargo.toml': PYO3_CARGO,
      'src/lib.rs': PYO3_MODULE,
      'scripts/run.py': `from _fastpath import parse\n\nprint(parse("x"))\n`,
    });
    expect(mechanismEdges(buildConnectionGraph(root, config), 'pyo3')).toHaveLength(0);
  });
});

describe('binding overrides that cannot apply', () => {
  it('reports an entry that names no Cargo package in the repository', () => {
    const root = repoWith({ 'Cargo.toml': PYO3_CARGO, 'src/lib.rs': PYO3_MODULE });
    const config = {
      version: 3,
      rust: { bindings: [{ kind: 'pyo3', crate: 'ghost', pythonModule: 'x' }] },
    } as Balk2Config;
    const { problems } = buildConnectionGraphDetailed(root, config);
    expect(problems).toContainEqual({
      path: 'rust.bindings[0].crate',
      message: 'no Cargo package named "ghost" in this repository; entry ignored',
    });
  });

  it('reports an entry whose package does not depend on the binding library', () => {
    const root = repoWith({ 'Cargo.toml': PYO3_CARGO, 'src/lib.rs': PYO3_MODULE });
    const config = {
      version: 3,
      rust: { bindings: [{ kind: 'wasm-bindgen', crate: 'fastpath', outDir: 'x' }] },
    } as Balk2Config;
    const { problems } = buildConnectionGraphDetailed(root, config);
    expect(problems).toContainEqual({
      path: 'rust.bindings[0].crate',
      message: '"fastpath" does not depend on wasm_bindgen; entry ignored',
    });
  });
});
