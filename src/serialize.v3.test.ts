import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from './graph.js';
import { NODE_KINDS } from './query/map-query.js';
import { convertV2ToV3, deserializeConnectionMap, serializeConnectionMap } from './serialize.js';
import type { ConnectionMapV2, PackageNode } from './types.js';

const META = { generatedAt: '2026-01-01T00:00:00Z' };

const INGEST: PackageNode = {
  kind: 'package',
  id: 'package:cargo:crates/ingest#bin:ingest',
  ecosystem: 'cargo',
  name: 'ingest',
  target: 'bin',
  manifest: 'crates/ingest/Cargo.toml',
  roots: ['crates/ingest/src/main.rs'],
  edition: '2021',
};

const WEB: PackageNode = {
  kind: 'package',
  id: 'package:npm:web',
  ecosystem: 'npm',
  name: 'web',
  manifest: 'web/package.json',
  roots: ['web/src/index.ts'],
};

function packagedGraph(): ConnectionGraph {
  const graph = new ConnectionGraph();
  graph.addPackage(WEB);
  graph.addPackage(INGEST);
  graph.addFile('crates/ingest/src/main.rs', 'rust');
  graph.addRelationship('packageRoot', INGEST.id, 'crates/ingest/src/main.rs', 'high');
  graph.addRelationship('dependsOn', WEB.id, INGEST.id, 'high');
  return graph;
}

describe('package nodes (schema version 3)', () => {
  it('builds a version 3 map with a package table sorted by id', () => {
    const map = packagedGraph().build(META);

    expect(map.version).toBe(3);
    expect(Object.keys(map.packages)).toEqual([INGEST.id, WEB.id]);
    expect(map.packages[INGEST.id]).toEqual(INGEST);
  });

  it('normalizes the manifest and root paths of a package', () => {
    const graph = new ConnectionGraph();
    graph.addPackage({ ...WEB, manifest: 'web\\package.json', roots: ['./web/src/index.ts'] });

    const map = graph.build(META);
    expect(map.packages[WEB.id]).toEqual(WEB);
  });

  it('keeps dependsOn and packageRoot in their forward direction', () => {
    const map = deserializeConnectionMap(serializeConnectionMap(packagedGraph().build(META)));

    expect(map.relationships).toEqual(
      expect.arrayContaining([
        { type: 'dependsOn', from: WEB.id, to: INGEST.id, confidence: 'high' },
        {
          type: 'packageRoot',
          from: INGEST.id,
          to: 'crates/ingest/src/main.rs',
          confidence: 'high',
        },
      ]),
    );
  });

  it('round-trips a version 3 map through serialization unchanged', () => {
    const json = serializeConnectionMap(packagedGraph().build(META));
    expect(serializeConnectionMap(deserializeConnectionMap(json))).toBe(json);
  });

  it('reads a version 3 map written without a package table as empty', () => {
    const parsed = JSON.parse(serializeConnectionMap(packagedGraph().build(META)));
    delete parsed.packages;

    expect(deserializeConnectionMap(JSON.stringify(parsed)).packages).toEqual({});
  });

  it('reads a version 3 map missing a later virtual-node table as empty', () => {
    const json = serializeConnectionMap(packagedGraph().build(META));
    const parsed = JSON.parse(json);
    delete parsed.registryKeys;

    const read = deserializeConnectionMap(JSON.stringify(parsed));
    expect(read.registryKeys).toEqual({});
    expect(serializeConnectionMap(read)).toBe(json);
  });

  it('rejects a package table that is not an object', () => {
    const parsed = JSON.parse(serializeConnectionMap(packagedGraph().build(META)));
    parsed.packages = [];

    expect(() => deserializeConnectionMap(JSON.stringify(parsed))).toThrow(
      'packages must be an object',
    );
  });

  it('lists package among the node kinds', () => {
    expect(NODE_KINDS).toContain('package');
  });
});

describe('version 2 to version 3 upgrade', () => {
  const base: ConnectionMapV2 = {
    version: 2,
    repository: META,
    files: { 'src/a.ts': { kind: 'file', path: 'src/a.ts', language: 'typescript' } },
    symbols: {},
    artifacts: {
      'Cargo.toml': { kind: 'artifact', path: 'Cargo.toml', format: 'toml' },
      'data/a.json': { kind: 'artifact', path: 'data/a.json', format: 'json' },
    },
    eventChannels: {},
    registryKeys: {},
    metadataKeys: {},
    resources: {},
    statePaths: {},
    unresolved: {},
    relationships: [],
  };

  it('moves an unreferenced manifest artifact to a tagged file node', () => {
    const map = convertV2ToV3(base);

    expect(map.version).toBe(3);
    expect(map.packages).toEqual({});
    expect(map.files['Cargo.toml']).toEqual({
      kind: 'file',
      path: 'Cargo.toml',
      language: 'cargo-manifest',
    });
    expect(Object.keys(map.artifacts)).toEqual(['data/a.json']);
    expect(Object.keys(map.files)).toEqual(['Cargo.toml', 'src/a.ts']);
  });

  it('keeps the artifact of a manifest that a relationship still names', () => {
    const map = convertV2ToV3({
      ...base,
      relationships: [{ type: 'consumes', from: 'src/a.ts', to: 'Cargo.toml', confidence: 'high' }],
    });

    expect(map.files['Cargo.toml']?.language).toBe('cargo-manifest');
    expect(map.artifacts['Cargo.toml']).toEqual(base.artifacts['Cargo.toml']);
    expect(map.relationships).toEqual([
      { type: 'consumes', from: 'src/a.ts', to: 'Cargo.toml', confidence: 'high' },
    ]);
  });
});
