import { describe, expect, it } from 'vitest';
import { buildConnectionGraph } from '../cli/build-graph.js';
import { loadBalk2Config } from '../config/balk2-config.js';

const ROOT = process.cwd();
const SUSPECTS = ['registryScopes', 'declared.set', 'rulesByName'];

describe('working repository: registry observations', () => {
  it('reports no dynamic-registry-key on the Phase 7 bookkeeping collections', () => {
    const config = loadBalk2Config(ROOT);
    console.log(
      'registries config in use:',
      JSON.stringify(config?.protocols?.registries ?? null, null, 2),
    );

    const graph = buildConnectionGraph(ROOT, config);
    const observed = Object.values(graph.build({ generatedAt: 'probe' }).unresolved)
      .filter((node) => node.reason === 'dynamic-registry-key')
      .map((node) => `${node.location.filePath}:${node.location.startLine} ${node.subject}`);

    console.log('dynamic-registry-key observations:\n' + observed.join('\n'));
    expect(observed.filter((line) => SUSPECTS.some((s) => line.includes(s)))).toEqual([]);
  });
});
