import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { MODULE_LOAD_CORPUS, type ModuleLoadFixture } from '../testing/module-load-corpus.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';
import type { Relationship } from '../types.js';
import { JsTsAnalyzer } from './js-ts-analyzer.js';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };
const OBSERVATION = 'unresolved:dynamic-module-specifier:';

const kindOf = (rel: Relationship): string => String(rel.metadata?.['loadKind'] ?? 'none');

/** What the graph says about one fixture, in the corpus's own vocabulary. */
function observe(fixture: ModuleLoadFixture): { edges: string[]; observations: string[] } {
  const repo = createRepositoryFixture(fixture.files, OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(repo.repository, graph, {
      loaders: fixture.loaders ?? [],
    });
    const imports = graph.getRelationships().filter((rel) => rel.type === 'imports');

    return {
      edges: imports
        .filter((rel) => !rel.to.startsWith(OBSERVATION))
        .map((rel) => `${rel.from} -> ${rel.to} [${kindOf(rel)}]`)
        .sort(),
      observations: imports
        .filter((rel) => rel.to.startsWith(OBSERVATION))
        .map((rel) => `${rel.from} [${kindOf(rel)}]`)
        .sort(),
    };
  } finally {
    repo.cleanup();
  }
}

describe('module load accuracy', () => {
  it.each(MODULE_LOAD_CORPUS.map((fixture) => [fixture.name, fixture] as const))(
    '%s',
    (_name, fixture) => {
      const actual = observe(fixture);
      const missing = new Set(fixture.limit?.missing ?? []);

      expect(actual.edges).toEqual(fixture.edges.filter((edge) => !missing.has(edge)).sort());
      expect(actual.observations).toEqual([...fixture.observations].sort());
      for (const edge of missing) {
        expect(actual.edges).not.toContain(edge);
      }
    },
  );

  it('every known limit names what it misses', () => {
    for (const fixture of MODULE_LOAD_CORPUS) {
      if (fixture.limit) {
        expect(fixture.limit.missing.length).toBeGreaterThan(0);
        expect(fixture.limit.note.length).toBeGreaterThan(0);
      }
    }
  });
});