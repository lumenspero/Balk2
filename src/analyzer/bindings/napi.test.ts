import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConnectionGraph } from '../../cli/build-graph.js';
import type { ConnectionGraph } from '../../graph.js';
import { camelCase } from '../rust/names/napi-bindings.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-napi-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

const CARGO_WITH_NAPI = `[package]
name = "core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
napi = "2"
napi-derive = "2"
`;

const CARGO_WITHOUT_NAPI = `[package]
name = "core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
`;

const PACKAGE_JSON = `{
  "name": "@app/core",
  "main": "index.js"
}
`;

const RUST_EXPORTS = `use napi_derive::napi;

#[napi]
pub fn parse_text(text: String) -> u32 {
    text.len() as u32
}

#[napi(js_name = "scoreOf")]
pub fn score(text: String) -> u32 {
    text.len() as u32
}

#[napi]
pub struct Index {
    size: u32,
}
`;

const JS_IMPORTS = `import { parseText, scoreOf, Index } from '@app/core';

export const run = (text: string) => parseText(text) + scoreOf(text);
export const index = new Index();
`;

function napiEdges(graph: ConnectionGraph): ReturnType<ConnectionGraph['getRelationships']> {
  return graph
    .getRelationships()
    .filter((r) => (r.metadata as Record<string, unknown> | undefined)?.mechanism === 'napi');
}

describe('napi-rs: #[napi] exports called from JS/TS', () => {
  it('writes a calls edge to each export, under its camelCase or js_name', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITH_NAPI,
      'package.json': PACKAGE_JSON,
      'src/lib.rs': RUST_EXPORTS,
      'web/src/search.ts': JS_IMPORTS,
    });
    const edges = napiEdges(buildConnectionGraph(root));
    expect(edges.map((e) => [e.type, e.from, e.to, e.confidence])).toEqual([
      ['calls', 'web/src/search.ts', 'src/lib.rs:parse_text', 'medium'],
      ['calls', 'web/src/search.ts', 'src/lib.rs:score', 'medium'],
      ['calls', 'web/src/search.ts', 'src/lib.rs:Index', 'medium'],
    ]);
  });

  it('writes no edge when the crate does not depend on napi', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITHOUT_NAPI,
      'package.json': PACKAGE_JSON,
      'src/lib.rs': RUST_EXPORTS,
      'web/src/search.ts': JS_IMPORTS,
    });
    expect(napiEdges(buildConnectionGraph(root))).toHaveLength(0);
  });

  it('writes no edge when the import names a different package', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITH_NAPI,
      'package.json': PACKAGE_JSON,
      'src/lib.rs': RUST_EXPORTS,
      'web/src/search.ts': `import { parseText } from 'some-other-package';\nexport const x = parseText;\n`,
    });
    expect(napiEdges(buildConnectionGraph(root))).toHaveLength(0);
  });

  it('writes no edge when the crate has no package.json to name the consumer', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITH_NAPI,
      'src/lib.rs': RUST_EXPORTS,
      'web/src/search.ts': JS_IMPORTS,
    });
    expect(napiEdges(buildConnectionGraph(root))).toHaveLength(0);
  });
});

describe('napi-rs naming', () => {
  it('follows napi-rs camelCase for underscore-separated names', () => {
    expect(camelCase('parse_text')).toBe('parseText');
    expect(camelCase('run')).toBe('run');
    expect(camelCase('a_b_c')).toBe('aBC');
  });
});
