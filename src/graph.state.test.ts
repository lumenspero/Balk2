import { describe, expect, it } from 'vitest';
import { ConnectionGraph, formatStatePath, statePathId } from './graph.js';
import { deserializeConnectionMap, serializeConnectionMap } from './serialize.js';
import type { ConnectionMap } from './types.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00.000Z' };

describe('formatStatePath', () => {
  it('joins identifier names with dots', () => {
    expect(formatStatePath(['store', 'session', 'user'])).toBe('store.session.user');
  });

  it('brackets names that are not identifiers', () => {
    expect(formatStatePath(['cache', 'a.b'])).toBe('cache["a.b"]');
    expect(formatStatePath(['cache', '0'])).toBe('cache["0"]');
    expect(formatStatePath(['my-key'])).toBe('["my-key"]');
  });

  it('writes a wildcard as [*] and a property named * as ["*"]', () => {
    expect(formatStatePath(['cache', null, 'value'])).toBe('cache[*].value');
    expect(formatStatePath(['cache', '*'])).toBe('cache["*"]');
  });

  it('is empty for the container', () => {
    expect(formatStatePath([])).toBe('');
  });
});

describe('statePathId', () => {
  it('names the container without a path', () => {
    expect(statePathId('global')).toBe('state:global');
    expect(statePathId('src/store.ts:store', [])).toBe('state:src/store.ts:store');
  });

  it('names a property path under its root', () => {
    expect(statePathId('global', ['store', 'user'])).toBe('state:global#store.user');
  });

  it('normalizes the root path', () => {
    expect(statePathId('src\\store.ts:store', ['a'])).toBe('state:src/store.ts:store#a');
  });

  it('keeps paths that differ only by escaping apart', () => {
    const ids = new Set([
      statePathId('global', ['a', 'b']),
      statePathId('global', ['a.b']),
      statePathId('global', ['a', null]),
      statePathId('global', ['a', '*']),
    ]);
    expect(ids.size).toBe(4);
  });
});

describe('ConnectionGraph.addStatePath', () => {
  it('stores root, kind, display path and segments', () => {
    const graph = new ConnectionGraph();
    const node = graph.addStatePath('src/store.ts:store', 'singleton', ['cart', null]);
    expect(node).toEqual({
      kind: 'state-path',
      id: 'state:src/store.ts:store#cart[*]',
      root: 'src/store.ts:store',
      rootKind: 'singleton',
      path: 'cart[*]',
      segments: ['cart', null],
    });
  });

  it('is a no-op when added again', () => {
    const graph = new ConnectionGraph();
    const first = graph.addStatePath('global', 'global', ['store']);
    const again = graph.addStatePath('global', 'global', ['store']);
    expect(again).toBe(first);
    expect(graph.nodeCount).toBe(1);
  });

  it('keeps the container and a property of it as separate nodes', () => {
    const graph = new ConnectionGraph();
    graph.addStatePath('config:appState', 'configured');
    graph.addStatePath('config:appState', 'configured', ['user']);
    expect(graph.hasStatePath('state:config:appState')).toBe(true);
    expect(graph.hasStatePath('state:config:appState#user')).toBe(true);
    expect(graph.nodeCount).toBe(2);
  });

  it('does not share its segments array with the caller', () => {
    const graph = new ConnectionGraph();
    const segments = ['a'];
    const node = graph.addStatePath('global', 'global', segments);
    segments.push('b');
    expect(node.segments).toEqual(['a']);
  });
});

describe('statePaths in the built map', () => {
  function build(): ConnectionMap {
    const graph = new ConnectionGraph();
    graph.addFile('src/a.ts', 'typescript');
    const user = graph.addStatePath('global', 'global', ['store', 'user']);
    const root = graph.addStatePath('global', 'global');
    graph.addRelationship('writesState', 'src/a.ts', user.id, 'high', {
      evidence: 'ts-program',
      metadata: { operation: 'assign' },
    });
    graph.addRelationship('readsState', 'src/a.ts', root.id, 'high');
    return graph.build(METADATA);
  }

  it('is sorted by id and placed after registryKeys', () => {
    const map = build();
    expect(Object.keys(map.statePaths)).toEqual(['state:global', 'state:global#store.user']);
    const keys = Object.keys(map);
    expect(keys.indexOf('statePaths')).toBe(keys.indexOf('registryKeys') + 1);
  });

  it('stores state relationships forward only', () => {
    const types = build().relationships.map((rel) => rel.type);
    expect(types).toEqual(['readsState', 'writesState']);
  });

  it('round-trips through JSON unchanged', () => {
    const map = build();
    const json = serializeConnectionMap(map);
    expect(deserializeConnectionMap(json)).toEqual(map);
    expect(serializeConnectionMap(deserializeConnectionMap(json))).toBe(json);
  });
});

describe('reading maps without statePaths', () => {
  it('reads a version 2 map written before state paths as an empty table', () => {
    const legacy = {
      version: 2,
      repository: METADATA,
      files: {},
      symbols: {},
      artifacts: {},
      eventChannels: {},
      registryKeys: {},
      unresolved: {},
      relationships: [],
    };
    const map = deserializeConnectionMap(JSON.stringify(legacy));
    expect(map.statePaths).toEqual({});
    expect(Object.keys(map)).toEqual(Object.keys(new ConnectionGraph().build(METADATA)));
  });

  it('gives a converted version 1 map an empty table', () => {
    const v1 = {
      version: 1,
      repository: METADATA,
      files: {},
      symbols: {},
      artifacts: {},
      relationships: [],
    };
    expect(deserializeConnectionMap(JSON.stringify(v1)).statePaths).toEqual({});
  });

  it('rejects a statePaths value that is not an object', () => {
    const bad = {
      version: 2,
      repository: METADATA,
      files: {},
      symbols: {},
      artifacts: {},
      eventChannels: {},
      unresolved: {},
      statePaths: [],
      relationships: [],
    };
    expect(() => deserializeConnectionMap(JSON.stringify(bad))).toThrow(
      'statePaths must be an object',
    );
  });
});