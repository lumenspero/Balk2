import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from './graph.js';
import { storedReverseTypes } from './testing/legacy-maps.js';

const META = { generatedAt: '2026-01-01T00:00:00Z' };

describe('ConnectionGraph and reverse relationship types', () => {
  it.each([
    ['importedBy', 'util.ts', 'main.ts', 'imports', 'main.ts', 'util.ts'],
    ['calledBy', 'util.ts:help', 'main.ts:run', 'calls', 'main.ts:run', 'util.ts:help'],
    ['generatedBy', 'data/out.json', 'build.js', 'generates', 'build.js', 'data/out.json'],
    ['consumedBy', 'data/out.json', 'load.ts', 'consumes', 'load.ts', 'data/out.json'],
  ] as const)(
    'stores %s as its forward relationship',
    (type, from, to, forward, fwdFrom, fwdTo) => {
      const graph = new ConnectionGraph();
      const stored = graph.addRelationship(type, from, to);

      expect(stored).toEqual({ type: forward, from: fwdFrom, to: fwdTo, confidence: 'high' });
      expect(graph.getRelationships()).toEqual([stored]);
    },
  );

  it('merges a reverse link with the forward relationship it repeats', () => {
    const graph = new ConnectionGraph();
    graph.addRelationship('calls', 'main.ts:run', 'util.ts:help', 'medium', {
      spans: [{ filePath: 'main.ts', startLine: 3, startColumn: 1, endLine: 3, endColumn: 9 }],
    });
    graph.addRelationship('calledBy', 'util.ts:help', 'main.ts:run', 'high', {
      evidence: 'ts-program',
    });

    expect(graph.relationshipCount).toBe(1);
    expect(graph.getRelationships()[0]).toMatchObject({
      type: 'calls',
      confidence: 'high',
      evidence: 'ts-program',
    });
    expect(graph.getRelationships()[0]?.spans).toHaveLength(1);
  });

  it('keeps the detail of a reverse link, turned around with it', () => {
    const graph = new ConnectionGraph();
    graph.addRelationship('importedBy', 'util.ts', 'main.ts', 'low', { evidence: 'heuristic' });

    expect(graph.getRelationships()).toEqual([
      { type: 'imports', from: 'main.ts', to: 'util.ts', confidence: 'low', evidence: 'heuristic' },
    ]);
  });

  it('never puts a reverse link in a built map, however callers add relationships', () => {
    const graph = new ConnectionGraph();
    for (const [type, from, to] of [
      ['importedBy', 'util.ts', 'main.ts'],
      ['calledBy', 'util.ts:help', 'main.ts:run'],
      ['generatedBy', 'data/out.json', 'build.js'],
      ['consumedBy', 'data/out.json', 'load.ts'],
    ] as const) {
      graph.addRelationship(type, from, to);
    }
    const map = graph.build(META);

    expect(storedReverseTypes(map)).toEqual([]);
    expect(map.relationships.map((r) => r.type)).toEqual([
      'calls',
      'consumes',
      'generates',
      'imports',
    ]);
  });

  it('counts a fact once however many times, and in whichever direction, it is added', () => {
    const graph = new ConnectionGraph();
    graph.addRelationship('imports', 'a.ts', 'b.ts');
    graph.addRelationship('importedBy', 'b.ts', 'a.ts');
    graph.addRelationship('imports', 'a.ts', 'b.ts');

    expect(graph.relationshipCount).toBe(1);
  });
});
