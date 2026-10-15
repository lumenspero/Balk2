import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateConfig } from '../config/state-config.js';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import { JsTsAnalyzer, type RepositoryAnalysis } from './js-ts-analyzer.js';

// Each case builds a TypeScript program; the default limit is tight under a parallel run.
vi.setConfig({ testTimeout: 30_000 });

/** Script files only exist as scripts under some settings, so every case runs under both. */
const TSCONFIGS: ReadonlyArray<readonly [string, Record<string, unknown> | undefined]> = [
  ['no tsconfig (node16 defaults)', undefined],
  ['esnext + bundler', { module: 'ESNext', moduleResolution: 'Bundler' }],
];

const STATE_TYPES = ['readsState', 'writesState', 'deletesState'];
const REGISTRY_TYPES = ['registers', 'resolves', 'routesTo'];

const STORE = {
  'src/store.ts': [
    'export const store: any = {};',
    'export const cache = new Map<string, number>();',
  ].join('\n'),
};
const CONFIG: StateConfig = {
  singletons: [
    { module: 'src/store.ts', export: 'store' },
    { module: 'src/store.ts', export: 'cache' },
  ],
};

/**
 * One line per relationship of the given types, sorted. A dynamic target is shown by its reason
 * only, since its id carries a source position.
 */
function summarize(graph: ConnectionGraph, types: readonly string[]): string[] {
  return graph
    .getRelationships()
    .filter((relationship) => types.includes(relationship.type))
    .map((relationship) => {
      const target = relationship.to.startsWith('unresolved:')
        ? relationship.to.split(':').slice(0, 2).join(':')
        : relationship.to;
      const metadata = relationship.metadata ? ` ${JSON.stringify(relationship.metadata)}` : '';
      return `${relationship.type} ${relationship.from} -> ${target}${metadata}`;
    })
    .sort();
}

describe.each(TSCONFIGS)('Phase 6.6: state relationships [%s]', (_label, compilerOptions) => {
  const fixtures: RepositoryFixture[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });

  function analyze(
    files: Record<string, string>,
    config?: StateConfig,
  ): { graph: ConnectionGraph; analysis: RepositoryAnalysis } {
    const fixture = createRepositoryFixture(files, compilerOptions);
    fixtures.push(fixture);
    const graph = new ConnectionGraph();
    const analysis = new JsTsAnalyzer().analyzeRepository(
      fixture.repository,
      graph,
      config ? { state: config } : {},
    );
    return { graph, analysis };
  }

  it('attributes each access to its enclosing function and writes the state-path node', () => {
    const { graph, analysis } = analyze(
      {
        ...STORE,
        'src/use.ts': [
          "import { store } from './store.js';",
          'export function load() { return store.user; }',
          'export function save(u: unknown) { store.user = u; }',
        ].join('\n'),
      },
      CONFIG,
    );

    expect(summarize(graph, STATE_TYPES)).toEqual(
      [
        'readsState src/use.ts:load -> state:src/store.ts:store#user {"operation":"read"}',
        'writesState src/use.ts:save -> state:src/store.ts:store#user {"operation":"assign"}',
      ].sort(),
    );
    expect(graph.hasStatePath('state:src/store.ts:store#user')).toBe(true);
    expect(analysis.stateProblems).toEqual([]);
  });

  it('records state method calls with the method in metadata', () => {
    const { graph } = analyze(
      {
        ...STORE,
        'src/use.ts': [
          "import { store } from './store.js';",
          "export function read() { return store.get('user'); }",
          "export function drop() { store.delete('user'); }",
        ].join('\n'),
      },
      CONFIG,
    );

    expect(summarize(graph, STATE_TYPES)).toEqual(
      [
        'readsState src/use.ts:read -> state:src/store.ts:store#user {"operation":"call","method":"get"}',
        'deletesState src/use.ts:drop -> state:src/store.ts:store#user {"operation":"call","method":"delete"}',
      ].sort(),
    );
  });

  it('records a computed key as a wildcard under wildcard', () => {
    const { graph } = analyze(
      {
        ...STORE,
        'src/use.ts': [
          "import { store } from './store.js';",
          'export function pick(key: string) { return store[key]; }',
        ].join('\n'),
      },
      { ...CONFIG, dynamicPaths: 'wildcard' },
    );
    expect(summarize(graph, STATE_TYPES)).toEqual([
      'readsState src/use.ts:pick -> state:src/store.ts:store#[*] {"operation":"read"}',
    ]);
  });

  it('reports a computed key as an unresolved observation under off, with no edge', () => {
    const { graph } = analyze(
      {
        ...STORE,
        'src/use.ts': [
          "import { store } from './store.js';",
          'export function pick(key: string) { return store[key]; }',
          'export function call(key: string) { store.get(key); }',
        ].join('\n'),
      },
      CONFIG,
    );

    expect(summarize(graph, STATE_TYPES)).toEqual(
      [
        'readsState src/use.ts:pick -> unresolved:dynamic-state-path',
        'readsState src/use.ts:call -> unresolved:dynamic-state-path',
      ].sort(),
    );
    expect(graph.getRelationships().some((r) => r.to.includes('#[*]'))).toBe(false);
  });

  it('leaves a state method call to state, so registry detection does not also see it', () => {
    const files = {
      ...STORE,
      'src/use.ts': [
        "import { cache } from './store.js';",
        "export function fill() { cache.set('user', 1); }",
        "export function look() { return cache.get('user'); }",
      ].join('\n'),
    };

    const withState = analyze(files, CONFIG);
    expect(summarize(withState.graph, STATE_TYPES)).toEqual(
      [
        'writesState src/use.ts:fill -> state:src/store.ts:cache#user {"operation":"call","method":"set"}',
        'readsState src/use.ts:look -> state:src/store.ts:cache#user {"operation":"call","method":"get"}',
      ].sort(),
    );
    expect(summarize(withState.graph, REGISTRY_TYPES)).toEqual([]);

    // Control: without the state config the same calls are ordinary registry lookups.
    const withoutState = analyze(files);
    expect(summarize(withoutState.graph, STATE_TYPES)).toEqual([]);
    expect(summarize(withoutState.graph, REGISTRY_TYPES).length).toBeGreaterThan(0);
  });

  it('tracks globals assigned by the repository without any configuration', () => {
    const { graph } = analyze({
      'src/boot.js': 'window.store = { user: null };',
      'src/use.ts': 'export {};\nexport function who() { return window.store.user; }',
    });

    expect(summarize(graph, STATE_TYPES)).toEqual(
      [
        'writesState src/boot.js -> state:global#store {"operation":"assign"}',
        'readsState src/use.ts:who -> state:global#store.user {"operation":"read"}',
      ].sort(),
    );
  });

  it('reports configured singletons that match no export, without writing them to the graph', () => {
    const { graph, analysis } = analyze(
      {
        ...STORE,
        'src/use.ts':
          "import { store } from './store.js';\nexport function f() { return store.user; }",
      },
      { singletons: [{ module: 'src/store.ts', export: 'nothing' }] },
    );

    expect(analysis.stateProblems).toEqual([
      {
        path: 'state.singletons[0].export',
        message: '"src/store.ts" has no export "nothing"; entry ignored',
      },
    ]);
    expect(summarize(graph, STATE_TYPES)).toEqual([]);
  });
});
