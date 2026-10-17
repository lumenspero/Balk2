import { JsTsAnalyzer } from '../analyzer/js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';
import type { GlobalFixture } from './global-corpus.js';
import { createRepositoryFixture } from './repository-fixture.js';

/** Run the analysis over a fixture and return the resulting map. */
export function analyzeGlobalFixture(fixture: GlobalFixture): ConnectionMap {
  const repository = createRepositoryFixture(fixture.files, {
    module: 'ESNext',
    moduleResolution: 'Bundler',
    target: 'es2020',
    strict: true,
  });
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(repository.repository, graph, fixture.options);
    return graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
  } finally {
    repository.cleanup();
  }
}

/** A node id that names a symbol, as opposed to a file path or an unresolved observation. */
function isSymbolId(id: string): boolean {
  return id.includes(':') && !id.startsWith('unresolved:');
}

/** Symbol-level references edges, as `caller -> target`, sorted and distinct. */
export function globalPairs(map: ConnectionMap): string[] {
  return [
    ...new Set(
      map.relationships
        .filter((rel) => rel.type === 'references' && isSymbolId(rel.from) && isSymbolId(rel.to))
        .map((rel) => `${rel.from} -> ${rel.to}`),
    ),
  ].sort();
}

/** Every references edge to a real node, file-level and symbol-level, as `references from -> to`. */
export function globalEdges(map: ConnectionMap): string[] {
  return map.relationships
    .filter((rel) => rel.type === 'references' && !rel.to.startsWith('unresolved:'))
    .map((rel) => `references ${rel.from} -> ${rel.to}`)
    .sort();
}
