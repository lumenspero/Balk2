import { describe, expect, it } from 'vitest';
import { applyDynamicPaths } from './dynamic-paths.js';
import type { StateReference } from './state-roots.js';

const STATIC: StateReference = {
  root: 'src/store.ts:store',
  rootKind: 'singleton',
  segments: ['cart', 'items'],
  confidence: 'high',
  evidence: 'config',
};

const DYNAMIC: StateReference = {
  root: 'src/store.ts:store',
  rootKind: 'singleton',
  segments: [null, 'items'],
  confidence: 'high',
  evidence: 'config',
  dynamicReason: 'key is a string but not a constant',
};

describe('Phase 6.5: dynamic path decisions', () => {
  it('records a static reference as an edge under either mode', () => {
    expect(applyDynamicPaths(STATIC, 'off')).toEqual({ kind: 'edge', reference: STATIC });
    expect(applyDynamicPaths(STATIC, 'wildcard')).toEqual({ kind: 'edge', reference: STATIC });
  });

  it('reports a dynamic reference as unresolved under off, with its reason', () => {
    expect(applyDynamicPaths(DYNAMIC, 'off')).toEqual({
      kind: 'unresolved',
      reference: DYNAMIC,
      reason: 'key is a string but not a constant',
    });
  });

  it('records a dynamic reference as an edge under wildcard, unchanged', () => {
    expect(applyDynamicPaths(DYNAMIC, 'wildcard')).toEqual({ kind: 'edge', reference: DYNAMIC });
  });

  it('falls back to a generic reason when a null segment has none', () => {
    const withoutReason: StateReference = {
      root: DYNAMIC.root,
      rootKind: DYNAMIC.rootKind,
      segments: DYNAMIC.segments,
      confidence: DYNAMIC.confidence,
      evidence: DYNAMIC.evidence,
    };
    expect(applyDynamicPaths(withoutReason, 'off')).toEqual({
      kind: 'unresolved',
      reference: withoutReason,
      reason: 'computed property',
    });
  });
});
