import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from './graph.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00Z' };

describe('ConnectionGraph relationship identity', () => {
  it('ignores a repeated (type, from, to) relationship', () => {
    const graph = new ConnectionGraph();
    graph.addRelationship('references', 'a.ts', 'b.ts');
    graph.addRelationship('references', './a.ts', 'b.ts');

    expect(graph.relationshipCount).toBe(1);
    expect(graph.getRelationships()).toHaveLength(1);
    expect(graph.build(METADATA).relationships).toHaveLength(1);
  });

  it('keeps distinct types and directions apart', () => {
    const graph = new ConnectionGraph();
    graph.addRelationship('calls', 'a.ts:f', 'b.ts:g');
    graph.addRelationship('calledBy', 'b.ts:g', 'a.ts:f');
    graph.addRelationship('calls', 'b.ts:g', 'a.ts:f');

    expect(graph.relationshipCount).toBe(3);
  });

  it('upgrades confidence but never downgrades it', () => {
    const graph = new ConnectionGraph();
    graph.addRelationship('references', 'a.ts', 'b.ts', 'low');
    graph.addRelationship('references', 'a.ts', 'b.ts', 'high');
    graph.addRelationship('references', 'a.ts', 'b.ts', 'medium');

    expect(graph.getRelationships()).toEqual([
      { type: 'references', from: 'a.ts', to: 'b.ts', confidence: 'high' },
    ]);
  });
});

describe('ConnectionGraph deterministic output', () => {
  it('sorts nodes and relationships by ordinal comparison, not locale', () => {
    const graph = new ConnectionGraph();
    graph.addFile('b.ts');
    graph.addFile('B.ts');
    graph.addFile('a.ts');
    graph.addRelationship('imports', 'b.ts', 'a.ts');
    graph.addRelationship('imports', 'B.ts', 'a.ts');

    const map = graph.build(METADATA);
    expect(Object.keys(map.files)).toEqual(['B.ts', 'a.ts', 'b.ts']);
    expect(map.relationships.map((r) => r.from)).toEqual(['B.ts', 'b.ts']);
  });

  it('produces identical output regardless of insertion order', () => {
    const edges: Array<[string, string]> = [
      ['x.ts', 'y.ts'],
      ['y.ts', 'z.ts'],
      ['z.ts', 'x.ts'],
    ];
    const build = (order: Array<[string, string]>): string => {
      const graph = new ConnectionGraph();
      for (const [from, to] of order) graph.addRelationship('imports', from, to);
      return JSON.stringify(graph.build(METADATA));
    };

    expect(build(edges)).toBe(build([...edges].reverse()));
  });
});
