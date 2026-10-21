import { describe, expect, it } from 'vitest';
import { COMPUTED_PROPERTY_DETAIL, runStateEngine } from './state-engine.js';
import type { FileFacts, StatePathFact } from './types.js';

const span = { filePath: 'src/m.ts', startLine: 4, startColumn: 1, endLine: 4, endColumn: 9 };

function access(overrides: Partial<StatePathFact>): StatePathFact {
  return {
    kind: 'state-path',
    filePath: 'src/m.ts',
    span,
    owner: 'src/m.ts:setup',
    relationship: 'readsState',
    operation: 'read',
    rootKind: 'global',
    root: 'global',
    segments: ['session', 'user'],
    confidence: 'high',
    evidence: 'ts-program',
    subject: 'store.session.user',
    ...overrides,
  };
}

function run(
  facts: StatePathFact[],
  dynamicPaths: 'off' | 'wildcard' = 'off',
): ReturnType<typeof runStateEngine> {
  const files: FileFacts[] = [{ filePath: 'src/m.ts', language: 'typescript', facts }];
  return runStateEngine({ files, dynamicPaths });
}

describe('runStateEngine', () => {
  it('links a static access to its path, with the operation as metadata', () => {
    expect(run([access({})])).toEqual([
      {
        kind: 'access',
        from: 'src/m.ts:setup',
        relationship: 'readsState',
        root: 'global',
        rootKind: 'global',
        segments: ['session', 'user'],
        confidence: 'high',
        evidence: 'ts-program',
        span,
        metadata: { operation: 'read' },
      },
    ]);
  });

  it('adds the method name to a state call', () => {
    const edges = run([access({ operation: 'call', method: 'get', relationship: 'readsState' })]);
    expect(edges[0]).toMatchObject({
      kind: 'access',
      metadata: { operation: 'call', method: 'get' },
    });
  });

  it('treats a computed key as an observation when dynamic paths are off', () => {
    expect(run([access({ segments: ['items', null] })], 'off')).toEqual([
      expect.objectContaining({
        kind: 'observation',
        detail: COMPUTED_PROPERTY_DETAIL,
        subject: 'store.session.user',
      }),
    ]);
  });

  it('records a computed key as an access when dynamic paths are wildcards', () => {
    expect(run([access({ segments: ['items', null] })], 'wildcard')).toEqual([
      expect.objectContaining({ kind: 'access', segments: ['items', null] }),
    ]);
  });

  it('prefers the fact’s own dynamic reason over the default detail', () => {
    expect(run([access({ segments: [null], dynamicReason: 'spread argument' })], 'off')).toEqual([
      expect.objectContaining({ kind: 'observation', detail: 'spread argument' }),
    ]);
  });
});
