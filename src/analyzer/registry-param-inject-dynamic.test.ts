import { describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';
import type { RegistryProtocolOptions } from './registry-protocols.js';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };
const META = { generatedAt: '2026-01-01T00:00:00Z' };
const REGISTRIES: RegistryProtocolOptions = {
  parameterDecorators: [{ name: 'Inject', registry: 'container.ts:container' }],
};

function analyze(files: Record<string, string>): ConnectionGraph {
  const fixture = createRepositoryFixture(files, OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, { registries: REGISTRIES });
    return graph;
  } finally {
    fixture.cleanup();
  }
}

describe('constructor injection with a dynamic token', () => {
  const files = {
    'container.ts': 'export const container = new Map<unknown, unknown>();',
    'inject.ts':
      'export function Inject(token: unknown) { return (t: unknown, k: unknown, i: number) => {}; }',
    'service.ts': [
      "import { Inject } from './inject.js';",
      'declare const tokens: unknown[];',
      'export class UserService {',
      '  constructor(@Inject(tokens[0]) private readonly repo: unknown) {}',
      '}',
    ].join('\n'),
  };

  it('reports the unreadable token as a dynamic-registry-key observation, not an edge', () => {
    const map = analyze(files).build(META);
    const observations = Object.values(map.unresolved).filter(
      (node) => node.reason === 'dynamic-registry-key',
    );
    expect(observations.map((node) => node.subject)).toEqual(['Inject(tokens[0])']);
  });

  it('links the observation to the injecting class at low confidence, with no resolves edge to a key', () => {
    const map = analyze(files).build(META);
    const observation = Object.values(map.unresolved).find(
      (node) => node.reason === 'dynamic-registry-key',
    );
    expect(map.relationships).toContainEqual(
      expect.objectContaining({
        type: 'resolves',
        from: 'service.ts:UserService',
        to: observation?.id,
        confidence: 'low',
      }),
    );
    expect(
      map.relationships.filter(
        (rel) =>
          rel.type === 'resolves' &&
          rel.from === 'service.ts:UserService' &&
          rel.to.startsWith('registry:'),
      ),
    ).toEqual([]);
  });
});
