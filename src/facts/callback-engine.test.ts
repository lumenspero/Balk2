import { describe, expect, it } from 'vitest';
import {
  runCallbackEngine,
  UNRESOLVED_CALLBACK_DETAIL,
  type CallbackCatalogEntry,
} from './callback-engine.js';
import type { CallSite, FileFacts } from './types.js';

const span = { filePath: 'src/m.ts', startLine: 3, startColumn: 1, endLine: 3, endColumn: 9 };
const catalog: CallbackCatalogEntry[] = [
  { function: 'onReady', callbackArg: 0, languages: ['typescript'] },
];

function call(
  name: string,
  resolution: Extract<CallSite['positional'][number], { kind: 'callback' }>['resolution'],
): CallSite {
  return {
    kind: 'call',
    filePath: 'src/m.ts',
    span,
    owner: 'src/m.ts:setup',
    name,
    positional: [{ kind: 'callback', span, resolution }],
    keyword: {},
  };
}

function run(facts: CallSite[]): ReturnType<typeof runCallbackEngine> {
  const files: FileFacts[] = [{ filePath: 'src/m.ts', language: 'typescript', facts }];
  return runCallbackEngine({ files, catalog });
}

describe('runCallbackEngine', () => {
  it('links a top-level callback to its symbol with ts-program evidence', () => {
    expect(run([call('onReady', { kind: 'symbol', id: 'src/m.ts:ready' })])).toEqual([
      {
        kind: 'passes',
        from: 'src/m.ts:setup',
        to: 'src/m.ts:ready',
        inline: false,
        evidence: 'ts-program',
        span,
      },
    ]);
  });

  it('links an inline callback to the enclosing owner, marked inline', () => {
    expect(run([call('onReady', { kind: 'inline' })])).toEqual([
      {
        kind: 'passes',
        from: 'src/m.ts:setup',
        to: 'src/m.ts:setup',
        inline: true,
        evidence: 'ast',
        span,
      },
    ]);
  });

  it('reports an unresolved callback as an observation and stays silent for external ones', () => {
    expect(run([call('onReady', { kind: 'unresolved', subject: 'makeHandler()' })])).toEqual([
      {
        kind: 'observation',
        from: 'src/m.ts:setup',
        subject: 'makeHandler()',
        detail: UNRESOLVED_CALLBACK_DETAIL,
        span,
      },
    ]);
    expect(run([call('onReady', { kind: 'external' })])).toEqual([]);
  });

  it('ignores calls that are not configured', () => {
    expect(run([call('other', { kind: 'symbol', id: 'src/m.ts:ready' })])).toEqual([]);
  });
});
