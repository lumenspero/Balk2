import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';
import { nodeKindOf, queryRelationships } from './map-query.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00Z' };
const CRATE = 'package:cargo:crates/core#lib:core';
const INGEST = 'package:cargo:crates/ingest#bin:ingest';

/** A small polyglot map: a Python script feeds JSON, a Rust crate is called from TypeScript. */
function polyglotMap(): ConnectionMap {
  const graph = new ConnectionGraph();
  graph.addFile('scripts/collect.py', 'python');
  graph.addFile('crates/core/src/lib.rs', 'rust');
  graph.addFile('crates/core/src/parse.rs', 'rust');
  graph.addFile('web/src/search.ts', 'typescript');
  graph.addFile('web/src/util.js', 'javascript');
  graph.addFile('crates/core/Cargo.toml', 'cargo-manifest');
  graph.addArtifact('data/raw.json', 'json');
  graph.addPackage({
    kind: 'package',
    id: CRATE,
    ecosystem: 'cargo',
    name: 'core',
    target: 'lib',
    manifest: 'crates/core/Cargo.toml',
    roots: ['crates/core/src/lib.rs'],
  });
  graph.addPackage({
    kind: 'package',
    id: INGEST,
    ecosystem: 'cargo',
    name: 'ingest',
    target: 'bin',
    manifest: 'crates/ingest/Cargo.toml',
    roots: [],
  });
  graph.addRelationship('dependsOn', INGEST, CRATE, 'high', {
    metadata: { kind: 'normal' },
  });
  graph.addRelationship('packageRoot', CRATE, 'crates/core/src/lib.rs', 'high');
  graph.addRelationship(
    'declaresModule',
    'crates/core/src/lib.rs',
    'crates/core/src/parse.rs',
    'high',
  );
  graph.addRelationship('calls', 'web/src/search.ts', 'crates/core/src/lib.rs', 'high', {
    metadata: { mechanism: 'wasm-bindgen' },
  });
  graph.addRelationship('imports', 'web/src/search.ts', 'web/src/util.js', 'high');
  graph.addRelationship('generates', 'scripts/collect.py', 'data/raw.json', 'high');
  graph.addRelationship('consumes', 'crates/core/src/lib.rs', 'data/raw.json', 'high');
  return graph.build(METADATA);
}

describe('nodeKindOf packages', () => {
  it('names a package node by its table', () => {
    expect(nodeKindOf(polyglotMap(), CRATE)).toBe('package');
  });
});

describe('queryRelationships package focus', () => {
  it('returns the package edges for a package focus', () => {
    const result = queryRelationships(polyglotMap(), { focus: CRATE, depth: 1 });
    const types = result.relationships.map((r) => `${r.type} ${r.from} ${r.to}`);
    expect(types).toContain(`dependsOn ${INGEST} ${CRATE}`);
    expect(types).toContain(`packageRoot ${CRATE} crates/core/src/lib.rs`);
  });
});

describe('queryRelationships language filter', () => {
  it('keeps only edges between files of the requested language', () => {
    const result = queryRelationships(polyglotMap(), { languages: ['rust'], families: ['code'] });
    const pairs = result.relationships.map((r) => `${r.from}>${r.to}`);
    expect(pairs).toContain('crates/core/src/lib.rs>crates/core/src/parse.rs');
    expect(pairs).not.toContain('web/src/search.ts>crates/core/src/lib.rs');
    expect(pairs).not.toContain('scripts/collect.py>data/raw.json');
  });

  it('drops a cross-language edge when only one of its languages is requested', () => {
    const result = queryRelationships(polyglotMap(), {
      languages: ['typescript'],
      families: ['code'],
    });
    const pairs = result.relationships.map((r) => `${r.from}>${r.to}`);
    expect(pairs).not.toContain('web/src/search.ts>crates/core/src/lib.rs');
    expect(pairs).not.toContain('web/src/search.ts>web/src/util.js');
  });

  it('keeps an edge whose endpoints are all requested languages', () => {
    const result = queryRelationships(polyglotMap(), {
      languages: ['typescript', 'javascript'],
      families: ['code'],
    });
    expect(result.relationships.map((r) => `${r.from}>${r.to}`)).toEqual([
      'web/src/search.ts>web/src/util.js',
    ]);
  });

  it('does not match an edge between language-neutral nodes', () => {
    const graph = new ConnectionGraph();
    graph.addFile('a/Cargo.toml', 'cargo-manifest');
    graph.addFile('b/Cargo.toml', 'cargo-manifest');
    graph.addRelationship('imports', 'a/Cargo.toml', 'b/Cargo.toml', 'high');
    const result = queryRelationships(graph.build(METADATA), { languages: ['rust'] });
    expect(result.relationships).toEqual([]);
  });
});

describe('queryRelationships ranking at a limit', () => {
  it('lists code edges before packaging edges at the same distance', () => {
    const graph = new ConnectionGraph();
    graph.addFile('crates/core/src/lib.rs', 'rust');
    graph.addFile('crates/core/src/parse.rs', 'rust');
    graph.addFile('crates/core/src/other.rs', 'rust');
    graph.addRelationship(
      'declaresModule',
      'crates/core/src/lib.rs',
      'crates/core/src/parse.rs',
      'high',
    );
    graph.addRelationship('imports', 'crates/core/src/lib.rs', 'crates/core/src/other.rs', 'high');
    const map = graph.build(METADATA);

    const all = queryRelationships(map, { focus: 'crates/core/src/lib.rs' });
    expect(all.relationships.map((r) => r.type)).toEqual(['imports', 'declaresModule']);

    const one = queryRelationships(map, { focus: 'crates/core/src/lib.rs', limit: 1 });
    expect(one.relationships.map((r) => r.type)).toEqual(['imports']);
    expect(one.truncated).toBe(true);
  });
});
