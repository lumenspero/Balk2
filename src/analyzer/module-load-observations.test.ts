import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import { collectModuleLoads } from './module-loads.js';
import { recordDynamicLoads } from './module-load-observations.js';

const lines = (...rows: string[]): string => rows.join('\n');

const FILES: Record<string, string> = {
  'util.ts': 'export const help = 1;',
  'main.ts': lines(
    "export const known = () => import('./util.js');",
    'export const computed = (name: string) => import(`./${name}.js`);',
    "export const worker = () => new Worker(new URL(`./${'w'}.js`, import.meta.url));",
  ),
};

const OBSERVATION_PREFIX = 'unresolved:dynamic-module-specifier:';

describe('recordDynamicLoads', () => {
  let fixture: RepositoryFixture | undefined;
  let graph: ConnectionGraph;

  beforeAll(() => {
    fixture = createRepositoryFixture(FILES, {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'Bundler',
    });
    graph = new ConnectionGraph();
    recordDynamicLoads(collectModuleLoads(fixture.repository), graph);
  });
  afterAll(() => fixture?.cleanup());

  const observationLinks = () =>
    graph
      .getRelationships()
      .filter((rel) => rel.type === 'imports' && rel.to.startsWith(OBSERVATION_PREFIX));

  it('records one observation per dynamic load and nothing for a constant specifier', () => {
    expect(observationLinks()).toHaveLength(2);
  });

  it('links each observation at low confidence, from the symbol that performs the load', () => {
    const links = observationLinks();
    expect(links.map((rel) => rel.from).sort()).toEqual([
      'main.ts:computed',
      'main.ts:worker',
    ]);
    for (const rel of links) {
      expect(rel).toMatchObject({ type: 'imports', confidence: 'low', evidence: 'ts-program' });
    }
  });

  it('keeps the load kind on the link, so a template import and a worker are told apart', () => {
    const kinds = observationLinks().map((rel) => rel.metadata?.loadKind);
    expect(kinds.sort()).toEqual(['import-expression', 'worker']);
  });

  it('does not create an imports edge to any file for a dynamic load', () => {
    const toFiles = graph
      .getRelationships()
      .filter((rel) => rel.type === 'imports' && rel.from.startsWith('main.ts'))
      .map((rel) => rel.to);
    expect(toFiles).not.toContain('util.ts');
  });
});