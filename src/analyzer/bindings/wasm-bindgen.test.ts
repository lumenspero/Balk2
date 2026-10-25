import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConnectionGraph } from '../../cli/build-graph.js';
import type { ConnectionGraph } from '../../graph.js';

/** A throwaway repository on disk, removed after each test. */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-wasm-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

const CARGO_WITH_WASM = `[package]
name = "core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
`;

const CARGO_WITHOUT_WASM = `[package]
name = "core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
`;

/** Rust exports `search` and `score` (exported as `rank`). */
const RUST_EXPORTS = `use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn search(query: &str) -> String {
    query.to_string()
}

#[wasm_bindgen(js_name = rank)]
pub fn score(query: &str) -> usize {
    query.len()
}
`;

/** JS imports the wasm-pack output of the crate. */
const JS_IMPORTS_WASM = `import { search, rank } from '../../pkg/core.js';

export function run(query: string): string {
  return search(query) + rank(query);
}
`;

/** Rust imports a JS module through an extern block, and exports a function that calls it. */
const RUST_IMPORTS_JS = `use wasm_bindgen::prelude::*;

#[wasm_bindgen(module = "/js/greet.js")]
extern "C" {
    fn greet(name: &str);
}

#[wasm_bindgen]
pub fn hello() {
    greet("world");
}
`;

const JS_GREET = `export function greet(name) {
  console.log(name);
}
`;

function mechanismEdges(graph: ConnectionGraph): ReturnType<ConnectionGraph['getRelationships']> {
  return graph
    .getRelationships()
    .filter(
      (r) => (r.metadata as Record<string, unknown> | undefined)?.mechanism === 'wasm-bindgen',
    );
}

describe('wasm-bindgen: Rust exports called from JS/TS', () => {
  it('writes a calls edge to each exported Rust function, under its js_name', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITH_WASM,
      'src/lib.rs': RUST_EXPORTS,
      'web/src/search.ts': JS_IMPORTS_WASM,
    });
    const edges = mechanismEdges(buildConnectionGraph(root));
    expect(edges.map((e) => [e.type, e.from, e.to, e.confidence])).toEqual([
      ['calls', 'web/src/search.ts', 'src/lib.rs:search', 'medium'],
      ['calls', 'web/src/search.ts', 'src/lib.rs:score', 'medium'],
    ]);
  });

  it('writes no edge when the crate does not depend on wasm-bindgen', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITHOUT_WASM,
      'src/lib.rs': RUST_EXPORTS,
      'web/src/search.ts': JS_IMPORTS_WASM,
    });
    expect(mechanismEdges(buildConnectionGraph(root))).toHaveLength(0);
  });

  it('writes no edge for a name the Rust crate does not export', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITH_WASM,
      'src/lib.rs': RUST_EXPORTS,
      'web/src/search.ts': `import { missing } from '../../pkg/core.js';\nexport const x = missing;\n`,
    });
    expect(mechanismEdges(buildConnectionGraph(root))).toHaveLength(0);
  });
});

describe('wasm-bindgen: JS modules imported by Rust', () => {
  it('writes an imports edge with the wasm-bindgen-module load kind, and a calls edge to the JS export', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITH_WASM,
      'src/lib.rs': RUST_IMPORTS_JS,
      'js/greet.js': JS_GREET,
    });
    const graph = buildConnectionGraph(root);
    const imports = graph
      .getRelationships()
      .filter((r) => r.type === 'imports' && r.from === 'src/lib.rs' && r.to === 'js/greet.js');
    expect(imports).toHaveLength(1);
    expect(imports[0]?.metadata).toMatchObject({ loadKind: 'wasm-bindgen-module' });

    const calls = mechanismEdges(graph);
    expect(calls.map((e) => [e.type, e.from, e.to])).toEqual([
      ['calls', 'src/lib.rs:greet', 'js/greet.js:greet'],
    ]);
  });
});

describe('wasm-bindgen: pairing and negatives', () => {
  it('does not bind a JS import of another JS module, even when names match', () => {
    const root = repoWith({
      'web/src/a.ts': `import { greet } from './b.js';\nexport const y = greet;\n`,
      'web/src/b.ts': `export function greet() {}\n`,
    });
    expect(mechanismEdges(buildConnectionGraph(root))).toHaveLength(0);
  });

  it('does not bind a Rust extern block to a JS module that is absent from the repository', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITH_WASM,
      'src/lib.rs': RUST_IMPORTS_JS,
    });
    const graph = buildConnectionGraph(root);
    expect(
      graph.getRelationships().filter((r) => r.type === 'imports' && r.to === 'js/greet.js'),
    ).toHaveLength(0);
    expect(mechanismEdges(graph)).toHaveLength(0);
  });
});
