import { describe, expect, it } from 'vitest';
import { buildConnectionGraph } from '../cli/build-graph.js';
import { loadBalk2Config } from '../config/balk2-config.js';
import { REGISTRY_CORPUS } from '../testing/registry-corpus.js';
import { analyzeRegistryFixture, registryEdges } from '../testing/registry-metrics.js';

const ROOT = process.cwd();
const SUSPECTS = ['registryScopes', 'declared.set', 'rulesByName'];
// A corpus case whose expected edges include `registers`, so detection is known to fire.
const REGISTRATION_CASE = 'container: classes registered on a Map and looked up';

describe('working repository: registry observations', () => {
  it('reports no dynamic-registry-key on the Phase 7 bookkeeping collections', () => {
    const config = loadBalk2Config(ROOT);
    console.log(
      'registries config in use:',
      JSON.stringify(config?.protocols?.registries ?? null, null, 2),
    );

    const graph = buildConnectionGraph(ROOT, config);
    const map = graph.build({ generatedAt: 'probe' });
    const observed = Object.values(map.unresolved)
      .filter((node) => node.reason === 'dynamic-registry-key')
      .map((node) => `${node.location.filePath}:${node.location.startLine} ${node.subject}`);

    console.log('dynamic-registry-key observations:\n' + observed.join('\n'));
    expect(observed.filter((line) => SUSPECTS.some((s) => line.includes(s)))).toEqual([]);
  });

  it('detects registers edges on a known registration case, so the absence check is not vacuous', () => {
    const fixture = REGISTRY_CORPUS.find((f) => f.name === REGISTRATION_CASE);
    expect(fixture).toBeDefined();
    if (!fixture) return;

    const registers = registryEdges(analyzeRegistryFixture(fixture)).filter((edge) =>
      edge.startsWith('registers '),
    );
    expect(registers.length).toBeGreaterThan(0);
  });
});
