import { describe, expect, it } from 'vitest';
import type { Fact, FactKind } from './types.js';

const span = { filePath: 'src/a.ts', startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 };

/** Exhaustive over `Fact`: adding a kind without a case is a compile error. */
function kindOf(fact: Fact): FactKind {
  switch (fact.kind) {
    case 'declaration':
    case 'module-edge':
    case 'reference':
    case 'call':
    case 'state-path':
    case 'directive':
      return fact.kind;
    default: {
      const unreachable: never = fact;
      throw new Error(`unknown fact ${JSON.stringify(unreachable)}`);
    }
  }
}

describe('facts model', () => {
  it('discriminates every fact kind', () => {
    const facts: Fact[] = [
      {
        kind: 'declaration',
        filePath: 'src/a.ts',
        span,
        id: 'src/a.ts:parse',
        name: 'parse',
        symbolType: 'function',
        owner: null,
        visibility: 'public',
        exported: true,
      },
      {
        kind: 'module-edge',
        filePath: 'src/a.ts',
        span,
        owner: null,
        form: 'import',
        specifier: './b',
        target: { kind: 'unresolved', reason: 'unresolved-module-path', subject: './b' },
        names: ['b'],
        typeOnly: false,
      },
      {
        kind: 'reference',
        filePath: 'src/a.ts',
        span,
        owner: 'src/a.ts:run',
        target: { kind: 'symbol', id: 'src/b.ts:parse' },
        role: 'call',
        confidence: 'high',
      },
      {
        kind: 'call',
        filePath: 'src/a.ts',
        span,
        owner: 'src/a.ts:run',
        callee: { kind: 'symbol', id: 'src/b.ts:User.save' },
        receiver: {
          identity: { kind: 'unknown' },
          type: { kind: 'symbol', id: 'src/b.ts:User' },
          typeConfidence: 'high',
        },
        methodName: 'save',
        positional: [{ kind: 'path', anchor: 'file-dir', path: 'data/x.json' }],
        keyword: { mode: { kind: 'string', value: 'w' } },
      },
      {
        kind: 'state-path',
        filePath: 'src/a.ts',
        span,
        owner: null,
        relationship: 'writesState',
        operation: 'assign',
        rootKind: 'module',
        root: 'src/a.ts:cart',
        segments: ['items', null],
        confidence: 'high',
        evidence: 'ts-program',
        subject: 'cart.items[k] = 1',
      },
      { kind: 'directive', filePath: 'src/a.ts', span, owner: null, text: 'reads: data/x.json' },
    ];

    expect(facts.map(kindOf)).toEqual([
      'declaration',
      'module-edge',
      'reference',
      'call',
      'state-path',
      'directive',
    ]);
  });
});
