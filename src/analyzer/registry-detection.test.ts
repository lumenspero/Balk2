import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';
import type { ConnectionMap, RegistryKeyNode, Relationship } from '../types.js';
import { JsTsAnalyzer, type RepositoryAnalysisOptions } from './js-ts-analyzer.js';

// Each group builds a TypeScript program; the default 5s limit is tight on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const META = { generatedAt: '2026-01-01T00:00:00Z' };
// Map and Set need the ES2020 library; the default target is too old to declare them.
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

/** The one key node with this key and keyType, in a registry whose scope ends with `scopeSuffix`. */
function keyNode(
  map: ConnectionMap,
  key: string,
  keyType: 'string' | 'number',
  scopeSuffix: string,
): RegistryKeyNode {
  const found = Object.values(map.registryKeys).filter(
    (node) => node.key === key && node.keyType === keyType && node.scope.endsWith(scopeSuffix),
  );
  if (found.length !== 1) {
    throw new Error(
      `Expected one ${keyType} key "${key}" in ${scopeSuffix}, found ${found.length}`,
    );
  }
  return found[0]!;
}

function edge(map: ConnectionMap, type: string, from: string, to: string): Relationship {
  const found = map.relationships.find((r) => r.type === type && r.from === from && r.to === to);
  if (!found) throw new Error(`No ${type} edge ${from} -> ${to}`);
  return found;
}

const USER = 'export class User {}';

describe('registry registrations and lookups', () => {
  let map: ConnectionMap;

  beforeAll(() => {
    map = analyze({
      'user.ts': USER,
      'container.ts': [
        "import { User } from './user.js';",
        'export const container = new Map<string, unknown>();',
        "container.set('user', User);",
        "export function lookup(): unknown { return container.get('user'); }",
      ].join('\n'),
    });
  });

  it('records the key once, typed as a string, scoped to its registry', () => {
    const node = keyNode(map, 'user', 'string', 'container.ts:container');
    expect(node.id).toBe(`registry:${node.scope}#user`);
  });

  it('links a registration to the class it maps to', () => {
    const node = keyNode(map, 'user', 'string', 'container.ts:container');
    const registration = edge(map, 'registers', node.id, 'user.ts:User');
    expect(registration.evidence).toBe('ts-program');
    expect(registration.spans?.[0]?.filePath).toBe('container.ts');
  });

  it('links a lookup to the key from the function that performs it', () => {
    const node = keyNode(map, 'user', 'string', 'container.ts:container');
    const lookup = edge(map, 'resolves', 'container.ts:lookup', node.id);
    expect(lookup.confidence).toBe('high');
  });
});

describe('numeric keys', () => {
  const map = analyze({
    'errors.ts': 'export class NotFound {}\nexport class Denied {}',
    'cache.ts': [
      "import { NotFound, Denied } from './errors.js';",
      'export const store = new Map<number, unknown>();',
      'store.set(404, NotFound);',
      'export function read(): unknown { return store.get(404); }',
      'export const handlers: Record<string, unknown> = {};',
      'handlers[401] = Denied;',
    ].join('\n'),
  });

  it('keeps a number in a Map as a typed key, distinct from its string form', () => {
    const node = keyNode(map, '404', 'number', 'cache.ts:store');
    expect(node.id).toContain('#number:404');
    edge(map, 'registers', node.id, 'errors.ts:NotFound');
    edge(map, 'resolves', 'cache.ts:read', node.id);
  });

  it('stores a number in a dictionary as a string key', () => {
    const node = keyNode(map, '401', 'string', 'cache.ts:handlers');
    expect(node.id).toBe(`registry:${node.scope}#401`);
    edge(map, 'registers', node.id, 'errors.ts:Denied');
  });
});

describe('what is not registered', () => {
  it('reports a dynamic key as unresolved, with no key node', () => {
    const map = analyze({
      'user.ts': USER,
      'dyn.ts': [
        "import { User } from './user.js';",
        'export const registry = new Map<string, unknown>();',
        'export function add(name: string): void { registry.set(name, User); }',
      ].join('\n'),
    });

    const reasons = Object.values(map.unresolved).map((node) => node.reason);
    expect(reasons).toContain('dynamic-registry-key');
    expect(Object.keys(map.registryKeys)).toHaveLength(0);
  });

  it('ignores a receiver that is not a registry, or whose type is unknown', () => {
    const map = analyze({
      'plain.ts': [
        'export class Store { set(k: string, v: unknown): void {} }',
        'declare const thing: any;',
        "export function run(s: Store): void { s.set('x', 1); thing.get('x'); }",
      ].join('\n'),
    });
    expect(Object.keys(map.registryKeys)).toHaveLength(0);
  });

  it('skips an assignment whose value is not a known symbol', () => {
    const map = analyze({
      'env.ts': ['export const env: Record<string, string> = {};', "env['MODE'] = 'prod';"].join(
        '\n',
      ),
    });
    expect(Object.keys(map.registryKeys)).toHaveLength(0);
  });
});

describe('configured registry protocols', () => {
  it('maps a configured method on a receiver that matches its rule', () => {
    const map = analyze(
      {
        'home.ts': 'export class Home {}',
        'app.ts': [
          "import { Home } from './home.js';",
          'export function boot(app: any): void { app.mount("home", Home); }',
        ].join('\n'),
      },
      {
        registries: {
          methods: [{ method: 'mount', direction: 'register', keyArg: 0, valueArg: 1 }],
        },
      },
    );

    const node = keyNode(map, 'home', 'string', 'app.ts:boot.app');
    const registration = edge(map, 'registers', node.id, 'home.ts:Home');
    expect(registration.evidence).toBe('config');
  });
});

describe('joining lookups to registrations', () => {
  const map = analyze({
    'user.ts': USER,
    'admin.ts': 'export class Admin {}',
    'a.ts': [
      "import { User } from './user.js';",
      'export const first = new Map<string, unknown>();',
      "first.set('user', User);",
      "export function read(): unknown { return first.get('user'); }",
    ].join('\n'),
    'b.ts': [
      "import { Admin } from './admin.js';",
      'export const second = new Map<string, unknown>();',
      "second.set('user', Admin);",
    ].join('\n'),
    // Declares its own key, but not 'user', which two other registries declare.
    'f.ts': [
      "import { Admin } from './admin.js';",
      'export const third = new Map<string, unknown>();',
      "third.set('admin', Admin);",
      "export function miss(): unknown { return third.get('user'); }",
    ].join('\n'),
    // Looks up a key nobody declares, and has no registrations of its own: left alone.
    'c.ts': [
      'export const other = new Map<string, unknown>();',
      "export function look(): unknown { return other.get('user'); }",
    ].join('\n'),
  });

  const ambiguous = Object.values(map.unresolved).filter(
    (node) => node.reason === 'ambiguous-registry',
  );

  it('agrees a lookup with the registration that shares its registry and key', () => {
    const node = keyNode(map, 'user', 'string', 'a.ts:first');
    edge(map, 'registers', node.id, 'user.ts:User');
    edge(map, 'resolves', 'a.ts:read', node.id);
    expect(ambiguous.some((u) => u.location.filePath === 'a.ts')).toBe(false);
  });

  it('lists the other registries that declare the key, instead of choosing one', () => {
    const first = keyNode(map, 'user', 'string', 'a.ts:first').id;
    const second = keyNode(map, 'user', 'string', 'b.ts:second').id;

    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.location.filePath).toBe('f.ts');
    expect(ambiguous[0]?.candidates).toEqual([first, second].sort());
  });

  it('does not flag a lookup into a registry with no declarations of its own', () => {
    expect(ambiguous.some((u) => u.location.filePath === 'c.ts')).toBe(false);
    keyNode(map, 'user', 'string', 'c.ts:other');
  });
});
