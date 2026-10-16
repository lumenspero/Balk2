import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMIT, QueryError, nodeKindOf, queryRelationships } from './map-query.js';
import { buildMap } from '../testing/connection-map-builder.js';
import type { Relationship } from '../types.js';

const rel = (
  type: Relationship['type'],
  from: string,
  to: string,
  confidence: Relationship['confidence'] = 'high',
): Relationship => ({ type, from, to, confidence });

// a -> b -> c -> d is a file chain. a emits evt, and c subscribes to it.
const FILES = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
const EVENTS = ['evt'];
const CHAIN: Relationship[] = [
  rel('imports', 'a.ts', 'b.ts', 'high'),
  rel('imports', 'b.ts', 'c.ts', 'medium'),
  rel('imports', 'c.ts', 'd.ts', 'low'),
  rel('emits', 'a.ts', 'evt', 'high'),
  rel('subscribes', 'c.ts', 'evt', 'high'),
];
const map = buildMap({ files: FILES, eventChannels: EVENTS }, CHAIN);

/** Edges as strings, sorted, so assertions do not depend on the map's canonical order. */
const edgesOf = (relationships: readonly Relationship[]): string[] =>
  relationships.map((r) => `${r.from}-${r.type}-${r.to}`).sort();

const expectEdges = (relationships: readonly Relationship[], expected: string[]): void => {
  expect(edgesOf(relationships)).toEqual([...expected].sort());
};

describe('queryRelationships', () => {
  it('leaves out low-confidence relationships by default', () => {
    const result = queryRelationships(map);
    expect(result.focus).toBeUndefined();
    expect(result.relationships).toHaveLength(CHAIN.length - 1);
    expect(result.total).toBe(CHAIN.length - 1);
    expect(result.truncated).toBe(false);
    expect(edgesOf(result.relationships)).not.toContain('c.ts-imports-d.ts');
  });

  it('includes low-confidence relationships when asked', () => {
    const result = queryRelationships(map, { minConfidence: 'low' });
    expect(result.relationships).toHaveLength(CHAIN.length);
  });

  it('keeps only the selected families', () => {
    const result = queryRelationships(map, { families: ['events'] });
    expectEdges(result.relationships, ['a.ts-emits-evt', 'c.ts-subscribes-evt']);
  });

  it('drops relationships below the confidence threshold', () => {
    const result = queryRelationships(map, { minConfidence: 'medium' });
    expect(result.relationships).toHaveLength(4);
    expect(edgesOf(result.relationships)).not.toContain('c.ts-imports-d.ts');
  });

  it('keeps only relationships whose endpoints are both of the given node kinds', () => {
    const result = queryRelationships(map, { nodeKinds: ['file'], minConfidence: 'low' });
    expectEdges(result.relationships, [
      'a.ts-imports-b.ts',
      'b.ts-imports-c.ts',
      'c.ts-imports-d.ts',
    ]);
  });

  it('limits output to one hop around a file by default', () => {
    const result = queryRelationships(map, { focus: 'a.ts' });
    expect(result.focus).toBe('a.ts');
    expectEdges(result.relationships, ['a.ts-imports-b.ts', 'a.ts-emits-evt']);
  });

  it('follows edges in either direction', () => {
    const result = queryRelationships(map, { focus: 'b.ts' });
    expectEdges(result.relationships, ['a.ts-imports-b.ts', 'b.ts-imports-c.ts']);
  });

  it('extends the neighborhood with depth and stops at the boundary', () => {
    const result = queryRelationships(map, { focus: 'a.ts', depth: 2 });
    expectEdges(result.relationships, [
      'a.ts-imports-b.ts',
      'b.ts-imports-c.ts',
      'a.ts-emits-evt',
      'c.ts-subscribes-evt',
    ]);
    expect(edgesOf(result.relationships)).not.toContain('c.ts-imports-d.ts');
  });

  it('accepts a backslash path for a file focus', () => {
    const nested = buildMap({ files: ['src/a.ts', 'src/b.ts'] }, [
      rel('imports', 'src/a.ts', 'src/b.ts'),
    ]);
    const result = queryRelationships(nested, { focus: 'src\\a.ts' });
    expect(result.focus).toBe('src/a.ts');
    expect(result.relationships).toHaveLength(1);
  });

  it('accepts an event channel as the focus', () => {
    const result = queryRelationships(map, { focus: 'evt' });
    expectEdges(result.relationships, ['a.ts-emits-evt', 'c.ts-subscribes-evt']);
  });

  it('reports the focus but no relationships at depth 0', () => {
    const result = queryRelationships(map, { focus: 'a.ts', depth: 0 });
    expect(result.focus).toBe('a.ts');
    expect(result.relationships).toEqual([]);
  });

  it('throws a QueryError for a focus that matches no node', () => {
    expect(() => queryRelationships(map, { focus: 'missing.ts' })).toThrow(QueryError);
    expect(() => queryRelationships(map, { focus: 'missing.ts' })).toThrow(
      'no node matches "missing.ts"',
    );
  });

  it('rejects a negative or fractional depth', () => {
    expect(() => queryRelationships(map, { focus: 'a.ts', depth: -1 })).toThrow(QueryError);
    expect(() => queryRelationships(map, { focus: 'a.ts', depth: 1.5 })).toThrow(QueryError);
  });
});

describe('queryRelationships limit', () => {
  it('caps the result and reports the total that matched', () => {
    const result = queryRelationships(map, { limit: 2, minConfidence: 'low' });
    expect(result.relationships).toHaveLength(2);
    expect(result.total).toBe(CHAIN.length);
    expect(result.truncated).toBe(true);
  });

  it('applies a default limit when none is given', () => {
    const hub = Array.from({ length: DEFAULT_LIMIT + 10 }, (_, i) =>
      rel('imports', 'src/hub.ts', `src/leaf${i}.ts`),
    );
    const files = ['src/hub.ts', ...hub.map((r) => r.to)];
    const big = buildMap({ files }, hub);

    const defaulted = queryRelationships(big, { focus: 'src/hub.ts' });
    expect(defaulted.relationships).toHaveLength(DEFAULT_LIMIT);
    expect(defaulted.total).toBe(DEFAULT_LIMIT + 10);
    expect(defaulted.truncated).toBe(true);

    const unlimited = queryRelationships(big, { focus: 'src/hub.ts', limit: Infinity });
    expect(unlimited.relationships).toHaveLength(DEFAULT_LIMIT + 10);
    expect(unlimited.truncated).toBe(false);
  });

  it('keeps the relationships nearest the focus when truncating', () => {
    const result = queryRelationships(map, { focus: 'a.ts', depth: 2, limit: 2 });
    expectEdges(result.relationships, ['a.ts-imports-b.ts', 'a.ts-emits-evt']);
    expect(result.total).toBe(4);
    expect(result.truncated).toBe(true);
  });

  it('rejects a limit of zero, a fraction, or a negative number', () => {
    expect(() => queryRelationships(map, { limit: 0 })).toThrow(QueryError);
    expect(() => queryRelationships(map, { limit: 1.5 })).toThrow(QueryError);
    expect(() => queryRelationships(map, { limit: -3 })).toThrow(QueryError);
  });
});

describe('nodeKindOf', () => {
  it('names the table an id belongs to', () => {
    expect(nodeKindOf(map, 'a.ts')).toBe('file');
    expect(nodeKindOf(map, 'evt')).toBe('event-channel');
    expect(nodeKindOf(map, 'nowhere')).toBeUndefined();
  });

  it('does not treat inherited object properties as nodes', () => {
    expect(nodeKindOf(map, 'constructor')).toBeUndefined();
    expect(nodeKindOf(map, 'toString')).toBeUndefined();
  });
});
