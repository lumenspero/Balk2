import { describe, expect, it } from 'vitest';
import { ConnectionGraph, registryKeyId } from './graph.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00Z' };

describe('registry-key nodes', () => {
  it('names a key by its registry identity and key', () => {
    expect(registryKeyId('user', 'src/container.ts:container')).toBe(
      'registry:src/container.ts:container#user',
    );
  });

  it('adds a key once and returns the same node when added again', () => {
    const graph = new ConnectionGraph();
    const first = graph.addRegistryKey('user', 'src/container.ts:container');
    const again = graph.addRegistryKey('user', 'src/container.ts:container');

    expect(again).toBe(first);
    expect(first).toEqual({
      kind: 'registry-key',
      id: 'registry:src/container.ts:container#user',
      key: 'user',
      scope: 'src/container.ts:container',
    });
    expect(graph.hasRegistryKey(first.id)).toBe(true);
    expect(graph.build(METADATA).registryKeys).toEqual({ [first.id]: first });
  });

  it('keeps the same key in two registries as two nodes', () => {
    const graph = new ConnectionGraph();
    graph.addRegistryKey('user', 'src/a.ts:container');
    graph.addRegistryKey('user', 'src/b.ts:container');

    expect(Object.keys(graph.build(METADATA).registryKeys)).toEqual([
      'registry:src/a.ts:container#user',
      'registry:src/b.ts:container#user',
    ]);
  });

  it('sorts the registry-key table by id', () => {
    const graph = new ConnectionGraph();
    graph.addRegistryKey('b', 'src/a.ts:reg');
    graph.addRegistryKey('a', 'src/a.ts:reg');

    expect(Object.keys(graph.build(METADATA).registryKeys)).toEqual([
      'registry:src/a.ts:reg#a',
      'registry:src/a.ts:reg#b',
    ]);
  });

  it('counts registry keys as nodes', () => {
    const graph = new ConnectionGraph();
    graph.addRegistryKey('user', 'src/a.ts:reg');

    expect(graph.nodeCount).toBe(1);
  });
});

describe('registry relationships', () => {
  it('stores registers, resolves and routesTo in their forward direction', () => {
    const graph = new ConnectionGraph();
    const key = graph.addRegistryKey('user', 'src/container.ts:container');
    graph.addRelationship('registers', key.id, 'src/user.ts:User');
    graph.addRelationship('resolves', 'src/app.ts:boot', key.id);
    graph.addRelationship('routesTo', 'src/nav.ts:go', key.id);

    const relationships = graph.build(METADATA).relationships;
    expect(relationships.map((r) => [r.type, r.from, r.to])).toEqual([
      ['registers', key.id, 'src/user.ts:User'],
      ['resolves', 'src/app.ts:boot', key.id],
      ['routesTo', 'src/nav.ts:go', key.id],
    ]);
  });
});
