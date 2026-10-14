import { describe, expect, it } from 'vitest';
import {
  canonicalRelationships,
  mergeRelationships,
  REVERSE_TO_FORWARD,
  toForward,
} from './relationship-types.js';
import type { Relationship } from './types.js';

const rel = (
  overrides: Partial<Relationship> & Pick<Relationship, 'type' | 'from' | 'to'>,
): Relationship => ({
  confidence: 'high',
  ...overrides,
});

describe('reverse relationship types', () => {
  it('names exactly the four reverse links of version 1 and what each repeats', () => {
    expect(REVERSE_TO_FORWARD).toEqual({
      importedBy: 'imports',
      calledBy: 'calls',
      generatedBy: 'generates',
      consumedBy: 'consumes',
    });
  });
});

describe('toForward', () => {
  it('turns a reverse link around, keeping everything else about it', () => {
    const span = { filePath: 'a.ts', startLine: 1, startColumn: 1, endLine: 1, endColumn: 4 };

    expect(
      toForward(
        rel({
          type: 'calledBy',
          from: 'util.ts:help',
          to: 'main.ts:run',
          confidence: 'medium',
          evidence: 'ts-program',
          spans: [span],
          metadata: { once: true },
        }),
      ),
    ).toEqual({
      type: 'calls',
      from: 'main.ts:run',
      to: 'util.ts:help',
      confidence: 'medium',
      evidence: 'ts-program',
      spans: [span],
      metadata: { once: true },
    });
  });

  it('returns a forward relationship as it is', () => {
    const forward = rel({ type: 'imports', from: 'a.ts', to: 'b.ts' });
    expect(toForward(forward)).toBe(forward);
  });
});

describe('canonicalRelationships', () => {
  const both = [
    rel({ type: 'importedBy', from: 'util.ts', to: 'main.ts' }),
    rel({ type: 'imports', from: 'main.ts', to: 'util.ts' }),
    rel({ type: 'consumedBy', from: 'data.json', to: 'load.ts' }),
    rel({ type: 'generates', from: 'build.js', to: 'data.json' }),
  ];

  it('holds each fact once, in forward form, sorted', () => {
    expect(canonicalRelationships(both)).toEqual([
      rel({ type: 'consumes', from: 'load.ts', to: 'data.json' }),
      rel({ type: 'generates', from: 'build.js', to: 'data.json' }),
      rel({ type: 'imports', from: 'main.ts', to: 'util.ts' }),
    ]);
  });

  it('is unaffected by input order and by being applied twice', () => {
    const once = canonicalRelationships(both);

    expect(canonicalRelationships([...both].reverse())).toEqual(once);
    expect(canonicalRelationships(once)).toEqual(once);
  });

  it('merges a fact seen in both directions at its highest confidence', () => {
    expect(
      canonicalRelationships([
        rel({ type: 'imports', from: 'a.ts', to: 'b.ts', confidence: 'low' }),
        rel({ type: 'importedBy', from: 'b.ts', to: 'a.ts', confidence: 'high', evidence: 'ast' }),
      ]),
    ).toEqual([rel({ type: 'imports', from: 'a.ts', to: 'b.ts', evidence: 'ast' })]);
  });

  it('sorts by ordinal comparison, not locale', () => {
    expect(
      canonicalRelationships([
        rel({ type: 'imports', from: 'b.ts', to: 'x.ts' }),
        rel({ type: 'imports', from: 'B.ts', to: 'x.ts' }),
      ]).map((r) => r.from),
    ).toEqual(['B.ts', 'b.ts']);
  });
});

describe('mergeRelationships', () => {
  it('combines spans, and keeps only the metadata both observations carry', () => {
    const span = (line: number): Relationship['spans'] => [
      { filePath: 'a.ts', startLine: line, startColumn: 1, endLine: line, endColumn: 5 },
    ];
    const merged = mergeRelationships(
      rel({
        type: 'subscribes',
        from: 'f',
        to: 'event:x',
        spans: span(9),
        metadata: { once: true, capture: true },
      }),
      rel({
        type: 'subscribes',
        from: 'f',
        to: 'event:x',
        spans: span(2),
        metadata: { once: true },
      }),
    );

    expect(merged.spans?.map((s) => s.startLine)).toEqual([2, 9]);
    expect(merged.metadata).toEqual({ once: true });
  });
});
