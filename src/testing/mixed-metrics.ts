import { JsTsAnalyzer } from '../analyzer/js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';
import { connectionPairs } from './event-metrics.js';
import type { MixedFixture } from './mixed-corpus.js';
import { registryPairs } from './registry-metrics.js';
import { statePairs } from './state-metrics.js';
import { createRepositoryFixture } from './repository-fixture.js';

/** Node families whose edges the mixed corpus checks, in addition to the global references. */
const FAMILY_TYPES = new Set([
  'emits',
  'subscribes',
  'registers',
  'resolves',
  'readsState',
  'writesState',
  'references',
]);

/** Run every analyzer pass over a mixed fixture and return the resulting map. */
export function analyzeMixedFixture(fixture: MixedFixture): ConnectionMap {
  const repository = createRepositoryFixture(fixture.files, {
    module: 'ESNext',
    moduleResolution: 'Bundler',
    target: 'es2020',
    strict: true,
  });
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(repository.repository, graph);
    return graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
  } finally {
    repository.cleanup();
  }
}

/** The family edges to real nodes, as `type from -> to`, sorted. */
export function mixedEdges(map: ConnectionMap): string[] {
  return map.relationships
    .filter((rel) => FAMILY_TYPES.has(rel.type) && !rel.to.startsWith('unresolved:'))
    .map((rel) => `${rel.type} ${rel.from} -> ${rel.to}`)
    .sort();
}

export { connectionPairs, registryPairs, statePairs };
