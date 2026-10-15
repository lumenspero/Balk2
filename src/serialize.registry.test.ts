import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from './graph.js';
import { convertV1ToV2, deserializeConnectionMap, serializeConnectionMap } from './serialize.js';
import type { ConnectionMapV1 } from './types.js';

const METADATA = { commit: 'abc1234', generatedAt: '2026-01-01T00:00:00Z' };

function registryMap(): ReturnType<ConnectionGraph['build']> {
  const graph = new ConnectionGraph();
  graph.addFile('src/app.ts', 'typescript');
  const key = graph.addRegistryKey('user', 'src/container.ts:container');
  graph.addRelationship('registers', key.id, 'src/user.ts:User', 'high', {
    evidence: 'ast',
    spans: [
      { filePath: 'src/container.ts', startLine: 4, startColumn: 3, endLine: 4, endColumn: 20 },
    ],
  });
  graph.addRelationship('resolves', 'src/app.ts', key.id, 'medium', { evidence: 'heuristic' });
  return graph.build(METADATA);
}

describe('registry keys in version 2 maps', () => {
  it('round-trips registry keys and their relationships', () => {
    const original = registryMap();
    const json = serializeConnectionMap(original);

    expect(deserializeConnectionMap(json)).toEqual(original);
    expect(serializeConnectionMap(deserializeConnectionMap(json))).toBe(json);
  });

  it('reads a version 2 map written before registry keys existed as an empty table', () => {
    const json = serializeConnectionMap(new ConnectionGraph().build(METADATA));
    const parsed: Record<string, unknown> = JSON.parse(json);
    const legacy = Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== 'registryKeys'));
    const read = deserializeConnectionMap(JSON.stringify(legacy));

    expect(read.registryKeys).toEqual({});
    expect(serializeConnectionMap(read)).toBe(json);
  });

  it('rejects a registryKeys value that is not an object', () => {
    const parsed: Record<string, unknown> = JSON.parse(
      serializeConnectionMap(new ConnectionGraph().build(METADATA)),
    );

    expect(() => deserializeConnectionMap(JSON.stringify({ ...parsed, registryKeys: [] }))).toThrow(
      'registryKeys must be an object',
    );
  });
});

describe('version 1 conversion', () => {
  it('starts the registry-key table empty', () => {
    const v1: ConnectionMapV1 = {
      version: 1,
      repository: METADATA,
      files: {},
      symbols: {},
      artifacts: {},
      relationships: [],
    };

    expect(convertV1ToV2(v1).registryKeys).toEqual({});
  });
});
