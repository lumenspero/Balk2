import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import type { RegistryProtocolOptions } from './registry-protocols.js';

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };
const META = { generatedAt: '2026-01-01T00:00:00Z' };

const lines = (...rows: string[]): string => rows.join('\n');

/** Caller to target pairs that share a registry key, as `caller -> target`. */
function pairsOf(graph: ConnectionGraph): string[] {
  const rels = graph.getRelationships();
  const pairs: string[] = [];
  for (const lookup of rels.filter((rel) => rel.type === 'resolves')) {
    for (const reg of rels.filter((rel) => rel.type === 'registers' && rel.from === lookup.to)) {
      pairs.push(`${lookup.from} -> ${reg.to}`);
    }
  }
  return pairs.sort();
}

function analyze(
  files: Record<string, string>,
  registries?: RegistryProtocolOptions,
): { graph: ConnectionGraph; fixture: RepositoryFixture } {
  const fixture = createRepositoryFixture(files, OPTIONS);
  const graph = new ConnectionGraph();
  new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, { registries });
  return { graph, fixture };
}

describe('class tokens are keys of their own kind', () => {
  const FILES = {
    'service.ts': 'export class UserService {}',
    'other.ts': 'export class Other {}',
    'container.ts': lines(
      "import { UserService } from './service.js';",
      "import { Other } from './other.js';",
      'export const container = new Map<unknown, unknown>();',
      'container.set(UserService, UserService);',
      "container.set('UserService', Other);",
      'export function byClass(): unknown { return container.get(UserService); }',
      "export function byName(): unknown { return container.get('UserService'); }",
    ),
  };

  let fixture: RepositoryFixture | undefined;
  let graph: ConnectionGraph;

  beforeAll(() => {
    const analyzed = analyze(FILES);
    fixture = analyzed.fixture;
    graph = analyzed.graph;
  });
  afterAll(() => fixture?.cleanup());

  it('links a class token to the class, and a string with the same text to its own target', () => {
    expect(pairsOf(graph)).toEqual([
      'container.ts:byClass -> service.ts:UserService',
      'container.ts:byName -> other.ts:Other',
    ]);
  });

  it('keeps the class token and the string as two distinct keys, typed by their kind', () => {
    const keys = Object.values(graph.build(META).registryKeys);
    expect(keys.map((key) => [key.key, key.keyType]).sort()).toEqual([
      ['UserService', 'string'],
      ['UserService', 'type'],
    ]);
  });

  it('gives the class-token key its own id, tagged with type', () => {
    const ids = Object.keys(graph.build(META).registryKeys);
    expect(ids.some((id) => id.includes('#type:UserService'))).toBe(true);
  });
});

describe('a type argument is read as the lookup key', () => {
  const FILES = {
    'service.ts': 'export class UserService {}',
    'container.ts': lines(
      "import { UserService } from './service.js';",
      'export class Container {',
      '  private readonly tokens = new Map<unknown, unknown>();',
      '  register(token: unknown, value: unknown): void { this.tokens.set(token, value); }',
      '  resolve<T>(): T { return undefined as T; }',
      '}',
      'export const container = new Container();',
      'container.register(UserService, UserService);',
      'export function load(): unknown { return container.resolve<UserService>(); }',
    ),
  };

  const registries: RegistryProtocolOptions = {
    methods: [{ method: 'resolve', direction: 'resolve', keyFrom: 'typeArgument' }],
  };

  let fixture: RepositoryFixture | undefined;
  let graph: ConnectionGraph;

  beforeAll(() => {
    const analyzed = analyze(FILES, registries);
    fixture = analyzed.fixture;
    graph = analyzed.graph;
  });
  afterAll(() => fixture?.cleanup());

  it('links the lookup with no argument to the class registered under the same token', () => {
    expect(pairsOf(graph)).toEqual(['container.ts:load -> service.ts:UserService']);
  });

  it('records a type-keyed lookup as a resolves edge to a type key, not as a dropped call', () => {
    const typeKeys = Object.values(graph.build(META).registryKeys).filter(
      (key) => key.keyType === 'type',
    );
    expect(typeKeys.map((key) => key.key)).toEqual(['UserService']);
  });
});
