import { JsTsAnalyzer } from '../analyzer/js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { getRegistrationTargets, getRegistryLookups } from '../graph-queries.js';
import type { ConnectionMap } from '../types.js';
import type { RegistryFixture } from './registry-corpus.js';
import { createRepositoryFixture } from './repository-fixture.js';

const REGISTRY_TYPES = new Set(['registers', 'resolves', 'routesTo']);

/** Run the registry pass over a fixture and return the resulting map. */
export function analyzeRegistryFixture(fixture: RegistryFixture): ConnectionMap {
  const repository = createRepositoryFixture(fixture.files, { target: 'es2020', strict: true });
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(repository.repository, graph, {
      ...(fixture.options ? { registries: fixture.options } : {}),
    });
    return graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
  } finally {
    repository.cleanup();
  }
}

/**
 * Every caller to target pair that shares a registry key, as `caller -> target`, sorted and
 * distinct. A pair exists only when the lookup and the registration agree on key and registry.
 */
export function registryPairs(map: ConnectionMap): string[] {
  const pairs = new Set<string>();
  for (const keyId of Object.keys(map.registryKeys)) {
    const callers = getRegistryLookups(map, keyId);
    const targets = getRegistrationTargets(map, keyId);
    for (const caller of callers) {
      for (const target of targets) pairs.add(`${caller} -> ${target}`);
    }
  }
  return [...pairs].sort();
}

/** Registry edges to real keys, as `type from -> to`, sorted. */
export function registryEdges(map: ConnectionMap): string[] {
  return map.relationships
    .filter((rel) => REGISTRY_TYPES.has(rel.type) && !rel.to.startsWith('unresolved:'))
    .map((rel) => `${rel.type} ${rel.from} -> ${rel.to}`)
    .sort();
}
