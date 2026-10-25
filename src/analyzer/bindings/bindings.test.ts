import { describe, expect, it } from 'vitest';
import type { SourceSpan } from '../../types.js';
import {
  BindingIndex,
  buildBindingIndex,
  collectConsumers,
  resolveBindingConsumers,
} from './index.js';
import type { BindingConsumer, BindingExport, FrontEndBindings } from './types.js';

const span = (line: number, column = 1): SourceSpan => ({
  filePath: 'web/src/search.ts',
  startLine: line,
  startColumn: column,
  endLine: line,
  endColumn: column + 10,
});

const exportOf = (overrides: Partial<BindingExport>): BindingExport => ({
  kind: 'wasm-bindgen',
  specifier: 'web/pkg/core.js',
  name: 'search',
  symbolId: 'crates/core/src/lib.rs:search',
  file: 'crates/core/src/lib.rs',
  confidence: 'high',
  ...overrides,
});

const consumerOf = (overrides: Partial<BindingConsumer>): BindingConsumer => ({
  kind: 'wasm-bindgen',
  specifier: 'web/pkg/core.js',
  name: 'search',
  file: 'web/src/search.ts',
  span: span(1),
  ...overrides,
});

describe('BindingIndex.match', () => {
  const index = new BindingIndex([exportOf({})]);

  it('matches a consumer to the producer that exports its name', () => {
    expect(index.match(consumerOf({}))).toEqual({ status: 'matched', export: exportOf({}) });
  });

  it('reports missing-name when the producer exists but does not export the name', () => {
    expect(index.match(consumerOf({ name: 'missing' }))).toEqual({ status: 'missing-name' });
  });

  it('reports no-producer for a specifier nothing publishes', () => {
    expect(index.match(consumerOf({ specifier: 'web/pkg/other.js' }))).toEqual({
      status: 'no-producer',
    });
  });

  it('does not match across kinds, even with the same specifier and name', () => {
    expect(index.match(consumerOf({ kind: 'pyo3' }))).toEqual({ status: 'no-producer' });
  });

  it('lists every candidate when two producers export the same name, and guesses none', () => {
    const ambiguous = new BindingIndex([
      exportOf({ symbolId: 'b.rs:search', file: 'b.rs' }),
      exportOf({ symbolId: 'a.rs:search', file: 'a.rs' }),
    ]);
    const match = ambiguous.match(consumerOf({}));
    expect(match.status).toBe('ambiguous');
    if (match.status !== 'ambiguous') return;
    expect(match.candidates.map((c) => c.file)).toEqual(['a.rs', 'b.rs']);
  });

  it('reports whether any producer publishes a kind and specifier', () => {
    expect(index.hasProducer('wasm-bindgen', 'web/pkg/core.js')).toBe(true);
    expect(index.hasProducer('pyo3', 'web/pkg/core.js')).toBe(false);
  });
});

describe('buildBindingIndex and collectConsumers', () => {
  const pyo3Results: FrontEndBindings = {
    exports: [exportOf({ kind: 'pyo3', specifier: 'app._fastpath', name: 'parse' })],
    consumers: [
      consumerOf({
        kind: 'pyo3',
        specifier: 'app._fastpath',
        name: 'parse',
        file: 'scripts/run.py',
      }),
    ],
  };
  const wasmResults: FrontEndBindings = {
    exports: [exportOf({})],
    consumers: [consumerOf({ file: 'web/src/search.ts', span: span(4) })],
  };

  it('gives the same resolution whatever order the front ends report in', () => {
    const consumers = collectConsumers([pyo3Results, wasmResults]);
    const forward = resolveBindingConsumers(
      buildBindingIndex([pyo3Results, wasmResults]),
      consumers,
    );
    const reversed = resolveBindingConsumers(
      buildBindingIndex([wasmResults, pyo3Results]),
      consumers,
    );
    expect(reversed).toEqual(forward);
    expect(forward.map((r) => r.match.status)).toEqual(['matched', 'matched']);
  });

  it('orders consumers by file, then position', () => {
    const consumers = collectConsumers([
      { exports: [], consumers: [consumerOf({ file: 'z.ts', span: span(1) })] },
      {
        exports: [],
        consumers: [
          consumerOf({ file: 'a.ts', span: span(9) }),
          consumerOf({ file: 'a.ts', span: span(2) }),
        ],
      },
    ]);
    expect(consumers.map((c) => `${c.file}:${c.span.startLine}`)).toEqual([
      'a.ts:2',
      'a.ts:9',
      'z.ts:1',
    ]);
  });

  it('skips front ends that published nothing', () => {
    const index = buildBindingIndex([undefined, undefined]);
    expect(index.hasProducer('wasm-bindgen', 'web/pkg/core.js')).toBe(false);
  });
});

describe('zero-diff precondition', () => {
  it('leaves every consumer as no-producer while no front end publishes an export', () => {
    const consumers = [consumerOf({}), consumerOf({ kind: 'pyo3', specifier: 'app._fastpath' })];
    const resolved = resolveBindingConsumers(buildBindingIndex([]), consumers);
    expect(resolved.map((r) => r.match)).toEqual([
      { status: 'no-producer' },
      { status: 'no-producer' },
    ]);
  });
});
