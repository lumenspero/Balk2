import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from './graph.js';
import { convertV1ToV2, deserializeConnectionMap, serializeConnectionMap } from './serialize.js';
import type { ConnectionMapV1 } from './types.js';

const METADATA = { commit: 'abc1234', generatedAt: '2026-01-01T00:00:00Z' };

/** A copy of `value` without one key. */
function without(value: object, key: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
}

const V1_MAP: ConnectionMapV1 = {
  version: 1,
  repository: METADATA,
  files: {
    'src/a.ts': { kind: 'file', path: 'src/a.ts', language: 'typescript' },
    'src/b.ts': { kind: 'file', path: 'src/b.ts', language: 'typescript' },
  },
  symbols: {
    'src/a.ts:f': {
      kind: 'symbol',
      id: 'src/a.ts:f',
      filePath: 'src/a.ts',
      name: 'f',
      symbolType: 'function',
    },
  },
  artifacts: {},
  relationships: [{ type: 'imports', from: 'src/a.ts', to: 'src/b.ts', confidence: 'high' }],
};

describe('version 1 compatibility', () => {
  it('reads a version 1 map as version 2 with empty virtual-node tables', () => {
    const map = deserializeConnectionMap(JSON.stringify(V1_MAP));

    expect(map.version).toBe(2);
    expect(map.eventChannels).toEqual({});
    expect(map.unresolved).toEqual({});
    expect(map.files).toEqual(V1_MAP.files);
    expect(map.relationships).toEqual(V1_MAP.relationships);
    expect(map.repository).toEqual(METADATA);
  });

  it('serializes a converted map exactly like a freshly built one', () => {
    const graph = new ConnectionGraph();
    graph.addFile('src/a.ts', 'typescript');
    graph.addFile('src/b.ts', 'typescript');
    graph.addSymbol('src/a.ts', 'f', 'function');
    graph.addRelationship('imports', 'src/a.ts', 'src/b.ts');

    expect(serializeConnectionMap(convertV1ToV2(V1_MAP))).toBe(
      serializeConnectionMap(graph.build(METADATA)),
    );
  });

  it('still validates the version 1 structure', () => {
    expect(() => deserializeConnectionMap(JSON.stringify(without(V1_MAP, 'files')))).toThrow(
      'missing files',
    );
  });
});

describe('version 2 maps', () => {
  it('round-trips event channels, unresolved nodes and relationship detail', () => {
    const graph = new ConnectionGraph();
    graph.addFile('src/a.ts', 'typescript');
    graph.addSymbol('src/a.ts', 'run', 'function');
    graph.addEventChannel('ready', 'src/a.ts:bus');
    graph.addRelationship('emits', 'src/a.ts:run', 'event:src/a.ts:bus#ready', 'high', {
      evidence: 'ts-program',
      spans: [{ filePath: 'src/a.ts', startLine: 3, startColumn: 5, endLine: 3, endColumn: 22 }],
      metadata: { once: true },
    });
    graph.addUnresolved({
      reason: 'dynamic-event-name',
      attempted: 'emits',
      subject: 'bus.emit(name)',
      location: { filePath: 'src/a.ts', startLine: 4, startColumn: 5, endLine: 4, endColumn: 19 },
    });

    const original = graph.build(METADATA);
    const json = serializeConnectionMap(original);

    expect(deserializeConnectionMap(json)).toEqual(original);
    expect(serializeConnectionMap(deserializeConnectionMap(json))).toBe(json);
  });

  it('requires the virtual-node tables', () => {
    const base: object = JSON.parse(serializeConnectionMap(new ConnectionGraph().build(METADATA)));

    expect(() => deserializeConnectionMap(JSON.stringify(without(base, 'eventChannels')))).toThrow(
      'missing eventChannels',
    );
    expect(() => deserializeConnectionMap(JSON.stringify(without(base, 'unresolved')))).toThrow(
      'missing unresolved',
    );
  });

  it('rejects versions it does not know', () => {
    expect(() => deserializeConnectionMap(JSON.stringify({ version: 3 }))).toThrow(
      'Unsupported connection map version: 3',
    );
  });
});
