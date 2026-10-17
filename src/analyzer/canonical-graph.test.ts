import { describe, expect, it, vi } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { EVENT_CORPUS } from '../testing/event-corpus.js';
import { analyzeFixture as analyzeEvent } from '../testing/event-metrics.js';
import { GLOBAL_CORPUS } from '../testing/global-corpus.js';
import { analyzeGlobalFixture } from '../testing/global-metrics.js';
import { canonicalGraph } from '../testing/canonical-graph.js';
import { MIXED_CORPUS } from '../testing/mixed-corpus.js';
import { analyzeMixedFixture } from '../testing/mixed-metrics.js';
import { MODULE_LOAD_CORPUS } from '../testing/module-load-corpus.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';
import { REGISTRY_CORPUS } from '../testing/registry-corpus.js';
import { analyzeRegistryFixture } from '../testing/registry-metrics.js';
import { STATE_CORPUS } from '../testing/state-corpus.js';
import { analyzeStateFixture } from '../testing/state-metrics.js';
import type { ConnectionMap } from '../types.js';
import { JsTsAnalyzer } from './js-ts-analyzer.js';

// Each case builds a TypeScript program; the default 5s limit is too tight on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const MODULE_LOAD_OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };

/** The module-load corpus analyzed as its own suite does, returned as a full map. */
function analyzeModuleLoad(index: number): ConnectionMap {
  const fixture = MODULE_LOAD_CORPUS[index];
  if (!fixture) throw new Error(`No module-load fixture at ${index}`);
  const repo = createRepositoryFixture(fixture.files, MODULE_LOAD_OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(repo.repository, graph, {
      loaders: fixture.loaders ?? [],
    });
    return graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
  } finally {
    repo.cleanup();
  }
}

/**
 * One fixture per relationship family, plus both mixed-mechanism fixtures. Each snapshot holds the
 * whole canonical graph, so a change in any node or edge, including structural ones, shows up.
 */
const CASES: ReadonlyArray<readonly [string, () => ConnectionMap]> = [
  ['events', (): ConnectionMap => analyzeEvent(EVENT_CORPUS[0]!)],
  ['registries', (): ConnectionMap => analyzeRegistryFixture(REGISTRY_CORPUS[0]!)],
  ['shared-state', (): ConnectionMap => analyzeStateFixture(STATE_CORPUS[0]!)],
  ['module-loads', (): ConnectionMap => analyzeModuleLoad(0)],
  ['globals', (): ConnectionMap => analyzeGlobalFixture(GLOBAL_CORPUS[0]!)],
  ['mixed-full-path', (): ConnectionMap => analyzeMixedFixture(MIXED_CORPUS[0]!)],
  ['mixed-other-receiver', (): ConnectionMap => analyzeMixedFixture(MIXED_CORPUS[1]!)],
];

describe('canonical graph snapshots', () => {
  it.each(CASES)('keeps the whole graph stable: %s', (slug, build) => {
    expect(canonicalGraph(build())).toMatchFileSnapshot(`../../test/snapshots/${slug}.txt`);
  });
});
