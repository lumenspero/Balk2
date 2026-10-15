import { JsTsAnalyzer } from '../analyzer/js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';
import type { StateFixture } from './state-corpus.js';
import { createRepositoryFixture } from './repository-fixture.js';

const STATE_TYPES = new Set(['readsState', 'writesState', 'deletesState']);

/** Run the state pass over a fixture and return the resulting map. */
export function analyzeStateFixture(fixture: StateFixture): ConnectionMap {
  const repository = createRepositoryFixture(fixture.files);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(repository.repository, graph, {
      ...(fixture.options ? { state: fixture.options } : {}),
    });
    return graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
  } finally {
    repository.cleanup();
  }
}

/**
 * Every owner to state-path pair, as `owner -> state:...`, sorted and distinct. An owner is tied
 * to a path by any read, write or delete, so the pair does not depend on the operation.
 */
export function statePairs(map: ConnectionMap): string[] {
  const pairs = new Set<string>();
  for (const rel of map.relationships) {
    if (STATE_TYPES.has(rel.type) && rel.to.startsWith('state:')) {
      pairs.add(`${rel.from} -> ${rel.to}`);
    }
  }
  return [...pairs].sort();
}

/** State edges to real paths, as `type owner -> state:...`, sorted. */
export function stateEdges(map: ConnectionMap): string[] {
  return map.relationships
    .filter((rel) => STATE_TYPES.has(rel.type) && rel.to.startsWith('state:'))
    .map((rel) => `${rel.type} ${rel.from} -> ${rel.to}`)
    .sort();
}
