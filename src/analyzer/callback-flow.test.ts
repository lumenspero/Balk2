import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import type { Relationship } from '../types.js';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };
const lines = (...rows: string[]): string => rows.join('\n');

const FILES: Record<string, string> = {
  'bus.ts': lines(
    'export function onReady(handler: () => void): void { handler(); }',
    'export function other(handler: () => void): void { handler(); }',
  ),
  'app.ts': lines(
    "import { onReady, other } from './bus.js';",
    'export function ready(): void {}',
    'export function setup(): void {',
    '  onReady(ready);',
    '  onReady(() => {});',
    '  other(ready);',
    '}',
  ),
};

/** `from -> to` for every relationship of one type, sorted. */
function edgesOf(graph: ConnectionGraph, type: Relationship['type']): string[] {
  return graph
    .getRelationships()
    .filter((rel) => rel.type === type)
    .map((rel) => `${rel.from} -> ${rel.to}`)
    .sort();
}

describe('callbacks passed to a configured function', () => {
  let fixture: RepositoryFixture | undefined;
  let graph: ConnectionGraph;

  beforeAll(() => {
    fixture = createRepositoryFixture(FILES, OPTIONS);
    graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, {
      callbacks: [{ function: 'onReady', callbackArg: 0 }],
    });
  });
  afterAll(() => fixture?.cleanup());

  it('links the enclosing caller to a named callback it passes, and only to configured functions', () => {
    expect(edgesOf(graph, 'passesCallback')).toEqual([
      'app.ts:setup -> app.ts:ready',
      'app.ts:setup -> app.ts:setup',
    ]);
  });

  it('keeps a named callback at high confidence, with its evidence and source span', () => {
    const edge = graph
      .getRelationships()
      .find((rel) => rel.type === 'passesCallback' && rel.to === 'app.ts:ready');
    expect(edge).toMatchObject({ confidence: 'high', evidence: 'ts-program' });
    expect(edge?.spans?.[0]).toMatchObject({ filePath: 'app.ts', startLine: 4 });
  });

  it('marks an inline callback as inline, so it is not mistaken for a named function', () => {
    const edge = graph
      .getRelationships()
      .find(
        (rel) =>
          rel.type === 'passesCallback' && rel.from === 'app.ts:setup' && rel.to === 'app.ts:setup',
      );
    expect(edge?.metadata).toEqual({ inline: true });
  });

  it('does not draw a callback as a call, so the existing calls graph is unchanged by it', () => {
    expect(edgesOf(graph, 'calls').filter((edge) => edge.endsWith('-> app.ts:ready'))).toEqual([]);
  });
});
