import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';
import type { ConnectionMap, RegistryKeyNode, Relationship } from '../types.js';
import { JsTsAnalyzer, type RepositoryAnalysisOptions } from './js-ts-analyzer.js';

vi.setConfig({ testTimeout: 30_000 });

const META = { generatedAt: '2026-01-01T00:00:00Z' };
const COMPILER_OPTIONS = { target: 'es2020', strict: true };

function analyze(
  files: Record<string, string>,
  options?: RepositoryAnalysisOptions,
): ConnectionMap {
  const fixture = createRepositoryFixture(files, COMPILER_OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, options);
    return graph.build(META);
  } finally {
    fixture.cleanup();
  }
}

function keyNode(map: ConnectionMap, key: string, scope: string): RegistryKeyNode {
  const found = Object.values(map.registryKeys).filter(
    (node) => node.key === key && node.scope === scope,
  );
  if (found.length !== 1)
    throw new Error(`Expected one key "${key}" in ${scope}, found ${found.length}`);
  return found[0]!;
}

function edge(map: ConnectionMap, type: string, from: string, to: string): Relationship {
  const found = map.relationships.find((r) => r.type === type && r.from === from && r.to === to);
  if (!found) throw new Error(`No ${type} edge ${from} -> ${to}`);
  return found;
}

describe('manifest registrations', () => {
  let map: ConnectionMap;

  beforeAll(() => {
    map = analyze(
      {
        'user.ts': 'export class User {}',
        'lookup.ts': [
          'export const reg = new Map<string, unknown>();',
          "export function get(): unknown { return reg.get('user'); }",
        ].join('\n'),
      },
      {
        registries: {
          manifest: [{ registry: 'lookup.ts:reg', key: 'user', target: 'user.ts:User' }],
        },
      },
    );
  });

  it('registers a key the code never registers, with config evidence', () => {
    const node = keyNode(map, 'user', 'lookup.ts:reg');
    expect(edge(map, 'registers', node.id, 'user.ts:User').evidence).toBe('config');
  });

  it('agrees a lookup with the manifest entry in the same registry', () => {
    const node = keyNode(map, 'user', 'lookup.ts:reg');
    edge(map, 'resolves', 'lookup.ts:get', node.id);
    const ambiguous = Object.values(map.unresolved).filter(
      (u) => u.reason === 'ambiguous-registry',
    );
    expect(ambiguous).toHaveLength(0);
  });
});

describe('discovery by file name', () => {
  const map = analyze(
    {
      'commands/ping.ts': 'export function ping(): void {}',
      'commands/stop.ts': 'export function stop(): void {}',
      'commands/readme.md': '# not a command',
      'cli.ts': [
        'export const commands = new Map<string, unknown>();',
        "export function run(): unknown { return commands.get('ping'); }",
      ].join('\n'),
    },
    {
      registries: {
        discover: [{ glob: 'commands/*.ts', registry: 'cli.ts:commands' }],
      },
    },
  );

  it('registers each matching file under its name, targeting the file', () => {
    const ping = keyNode(map, 'ping', 'cli.ts:commands');
    expect(edge(map, 'registers', ping.id, 'commands/ping.ts').evidence).toBe('config');
    keyNode(map, 'stop', 'cli.ts:commands');
  });

  it('does not register files outside the glob', () => {
    expect(Object.values(map.registryKeys).some((node) => node.key === 'readme')).toBe(false);
  });

  it('links a lookup that agrees with the discovered key', () => {
    const ping = keyNode(map, 'ping', 'cli.ts:commands');
    edge(map, 'resolves', 'cli.ts:run', ping.id);
  });
});

describe('decorator registrations', () => {
  const map = analyze(
    {
      'user.ts': [
        'export function register(key: string) { return (target: unknown): unknown => target; }',
        "@register('user')",
        'export class User {}',
      ].join('\n'),
      'plain.ts': "export function other(key: string): void {}\n@other('x')\nexport class Plain {}",
    },
    {
      registries: {
        decorators: [{ name: 'register', registry: 'user.ts:registry' }],
      },
    },
  );

  it('registers the decorated class under the decorator key', () => {
    const node = keyNode(map, 'user', 'user.ts:registry');
    expect(edge(map, 'registers', node.id, 'user.ts:User').evidence).toBe('config');
  });

  it('ignores decorators the config does not name', () => {
    expect(Object.values(map.registryKeys).some((node) => node.key === 'x')).toBe(false);
  });
});

describe('dictionary literals', () => {
  const map = analyze({
    'home.ts': 'export class Home {}',
    'routes.ts': [
      "import { Home } from './home.js';",
      'export const routes: Record<string, unknown> = { home: Home, 404: Home };',
      'export const options = { debug: Home };',
    ].join('\n'),
  });

  it('registers each property whose value is a symbol, in a dictionary-typed declaration', () => {
    const home = keyNode(map, 'home', 'routes.ts:routes');
    expect(edge(map, 'registers', home.id, 'home.ts:Home').evidence).toBe('ts-program');
    const notFound = keyNode(map, '404', 'routes.ts:routes');
    edge(map, 'registers', notFound.id, 'home.ts:Home');
  });

  it('does not treat an untyped config object as a registry', () => {
    expect(Object.values(map.registryKeys).some((node) => node.scope === 'routes.ts:options')).toBe(
      false,
    );
  });
});
