import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import type { RegistryProtocolOptions } from './registry-protocols.js';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };
const META = { generatedAt: '2026-01-01T00:00:00Z' };

const lines = (...rows: string[]): string => rows.join('\n');

const REGISTRIES: RegistryProtocolOptions = {
  parameterDecorators: [{ name: 'Inject', registry: 'container.ts:container' }],
};

interface Analysis {
  readonly graph: ConnectionGraph;
  readonly fixture: RepositoryFixture;
}

function analyze(
  files: Record<string, string>,
  registries: RegistryProtocolOptions = REGISTRIES,
): Analysis {
  const fixture = createRepositoryFixture(files, OPTIONS);
  const graph = new ConnectionGraph();
  new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, { registries });
  return { graph, fixture };
}

const FILES = {
  'repo.ts': 'export class UserRepo {}',
  'container.ts': lines('export const container = new Map<unknown, unknown>();'),
  'service.ts': lines(
    "import { UserRepo } from './repo.js';",
    "import { Inject } from './inject.js';",
    'export class UserService {',
    '  constructor(@Inject(UserRepo) private readonly repo: UserRepo) {}',
    '}',
  ),
  'inject.ts':
    'export function Inject(token: unknown) { return (t: unknown, k: unknown, i: number) => {}; }',
  'wiring.ts': lines(
    "import { UserRepo } from './repo.js';",
    "import { container } from './container.js';",
    'container.set(UserRepo, UserRepo);',
  ),
};

describe('constructor parameter injection', () => {
  let fixture: RepositoryFixture | undefined;
  let graph: ConnectionGraph;

  beforeAll(() => {
    const analyzed = analyze(FILES);
    fixture = analyzed.fixture;
    graph = analyzed.graph;
  });
  afterAll(() => fixture?.cleanup());

  it('links the injecting class to the class token it depends on', () => {
    const lookups = graph
      .getRelationships()
      .filter((rel) => rel.type === 'resolves' && rel.from === 'service.ts:UserService');
    expect(lookups).toHaveLength(1);
  });

  it('keys the dependency as a class token, matching the registration', () => {
    const key = Object.values(graph.build(META).registryKeys).find(
      (node) => node.key === 'UserRepo',
    );
    expect(key?.keyType).toBe('type');
  });

  it('the injected dependency reaches the class registered under the same token', () => {
    const edges = graph
      .getRelationships()
      .filter((rel) => rel.type === 'resolves' && rel.from === 'service.ts:UserService');
    const reg = graph
      .getRelationships()
      .filter((rel) => rel.type === 'registers' && rel.from === edges[0]?.to);
    expect(reg.map((rel) => rel.to)).toEqual(['repo.ts:UserRepo']);
  });

  it('leaves a parameter decorator without a configured name alone', () => {
    const other = analyze({
      ...FILES,
      'service.ts': FILES['service.ts'].replace('@Inject', '@Other'),
    });
    try {
      // The constructor parameter's type is still a `references` edge (JS type references, Phase 13).
      // Only the injection edges are asserted absent here.
      expect(
        other.graph
          .getRelationships()
          .filter((rel) => rel.from === 'service.ts:UserService' && rel.type !== 'references'),
      ).toEqual([]);
    } finally {
      other.fixture.cleanup();
    }
  });
});
