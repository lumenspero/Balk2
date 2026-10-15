import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import type { LoaderProtocol } from './loader-protocols.js';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import type { Relationship } from '../types.js';

const lines = (...rows: string[]): string => rows.join('\n');

const FILES: Record<string, string> = {
  'util.ts': 'export const help = 1;',
  'plugins-api.ts': 'export const api = 1;',
  'main.ts': lines(
    "import { help } from './util.js';",
    'declare function loadPlugin(specifier: string): unknown;',
    'declare const plugins: { load(specifier: string): unknown };',
    'declare const other: { load(specifier: string): unknown };',
    "export const lazy = () => import('./util.js');",
    "export const viaPlain = () => loadPlugin('./plugins-api.js');",
    "export const viaPlugins = () => plugins.load('./util.js');",
    "export const viaOther = () => other.load('./util.js');",
    'export const kept = help;',
  ),
};

const LOADERS: LoaderProtocol[] = [
  { function: 'loadPlugin', specifierArg: 0 },
  { function: 'load', specifierArg: 0, receiver: { names: ['plugins'] } },
];

describe('module load edges', () => {
  let fixture: RepositoryFixture | undefined;
  let graph: ConnectionGraph;

  beforeAll(() => {
    fixture = createRepositoryFixture(FILES, {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
    });
    graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, { loaders: LOADERS });
  });
  afterAll(() => fixture?.cleanup());

  const edgesFrom = (from: string, to: string): Relationship[] =>
    graph
      .getRelationships()
      .filter((rel) => rel.type === 'imports' && rel.from === from && rel.to === to);

  it('leaves the static file-level import unchanged, with no loadKind', () => {
    const [edge] = edgesFrom('main.ts', 'util.ts');
    expect(edge).toBeDefined();
    expect(edge?.metadata).toBeUndefined();
  });

  it('adds a symbol-level edge for a dynamic import inside a function, with its loadKind', () => {
    expect(edgesFrom('main.ts:lazy', 'util.ts')).toEqual([
      expect.objectContaining({
        confidence: 'high',
        metadata: { loadKind: 'import-expression' },
      }),
    ]);
  });

  it('links a configured plain loader call to its target, with loadKind loader', () => {
    expect(edgesFrom('main.ts:viaPlain', 'plugins-api.ts')).toEqual([
      expect.objectContaining({ metadata: { loadKind: 'loader' } }),
    ]);
  });

  it('links a receiver-scoped loader call only when the receiver name matches', () => {
    expect(edgesFrom('main.ts:viaPlugins', 'util.ts')).toHaveLength(1);
    expect(edgesFrom('main.ts:viaOther', 'util.ts')).toHaveLength(0);
  });

  it('keeps the file-level edge singular, so the dynamic load does not duplicate it', () => {
    expect(edgesFrom('main.ts', 'util.ts')).toHaveLength(1);
  });
});
