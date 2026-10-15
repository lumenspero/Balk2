import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateConfig } from '../config/state-config.js';
import { statePathId } from '../graph.js';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import { collectGlobalSymbols } from './global-symbols.js';
import {
  collectStateCalls,
  type StateCallFact,
  type StateCallReport,
  stateCallOptions,
} from './state-calls.js';
import { StateRootResolver } from './state-roots.js';

// Each case builds a TypeScript program; the default limit is tight under a parallel run.
vi.setConfig({ testTimeout: 30_000 });

/** Script files only exist as scripts under some settings, so every case runs under both. */
const TSCONFIGS: ReadonlyArray<readonly [string, Record<string, unknown> | undefined]> = [
  ['no tsconfig (node16 defaults)', undefined],
  ['esnext + bundler', { module: 'ESNext', moduleResolution: 'Bundler' }],
];

/** `any` keeps the fixtures free of type errors that have nothing to do with state. */
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

function describeCall(fact: StateCallFact): string {
  const id = statePathId(fact.reference.root, fact.reference.segments);
  return `${fact.relationship} ${fact.method} ${id}`;
}

describe.each(TSCONFIGS)('Phase 6.5: state method calls [%s]', (_label, compilerOptions) => {
  const fixtures: RepositoryFixture[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });

  function collect(
    files: Record<string, string>,
    probeFile: string,
    config: StateConfig = CONFIG,
  ): StateCallReport {
    const fixture = createRepositoryFixture(files, compilerOptions);
    fixtures.push(fixture);
    const { repository } = fixture;
    const resolver = new StateRootResolver(repository, collectGlobalSymbols(repository), config);
    const sourceFile = repository.sourceFiles.get(probeFile);
    if (!sourceFile) throw new Error(`${probeFile} was not analyzed`);
    return collectStateCalls(sourceFile, probeFile, resolver, stateCallOptions(config));
  }

  it('records the built-in methods on a singleton and on a path below it', () => {
    const report = collect(
      {
        ...STORE,
        'src/use.ts': [
          "import { store, cache } from './store.js';",
          'declare const u: unknown;',
          "store.get('user');",
          "store.has('user');",
          "store.set('user', u);",
          "store.delete('user');",
          'store.subscribe(() => {});',
          "store.cart.get('items');",
          "cache.get('x');",
        ].join('\n'),
      },
      'src/use.ts',
    );

    expect(report.calls.map(describeCall)).toEqual([
      'readsState get state:src/store.ts:store#user',
      'readsState has state:src/store.ts:store#user',
      'writesState set state:src/store.ts:store#user',
      'deletesState delete state:src/store.ts:store#user',
      'readsState subscribe state:src/store.ts:store',
      'readsState get state:src/store.ts:store#cart.items',
      'readsState get state:src/store.ts:cache#x',
    ]);
    expect(report.calls.every((fact) => fact.operation === 'call')).toBe(true);
    expect(report.calls[0]?.reference.confidence).toBe('high');
    // Each matched call is claimed, so registry detection does not also see it.
    expect(report.claimed.size).toBe(7);
  });

  it('never matches a method on a receiver that is not shared state', () => {
    const report = collect(
      {
        ...STORE,
        'src/use.ts': [
          'export {};',
          'const local = new Map<string, number>();',
          "local.get('x');",
          'const unrelated: any = {};',
          "unrelated.get('x');",
          "window.get('x');",
        ].join('\n'),
      },
      'src/use.ts',
    );
    expect(report.calls).toEqual([]);
    expect(report.unresolved).toEqual([]);
    expect(report.claimed.size).toBe(0);
  });

  it('follows const aliases at the same confidence as a property access', () => {
    const report = collect(
      {
        ...STORE,
        'src/use.ts': [
          "import { store } from './store.js';",
          'const same = store;',
          "same.get('user');",
          'const cart = store.cart;',
          "cart.get('items');",
          'let later = store;',
          "later.get('user');",
        ].join('\n'),
      },
      'src/use.ts',
    );
    expect(report.calls.map(describeCall)).toEqual([
      'readsState get state:src/store.ts:store#user',
      'readsState get state:src/store.ts:store#cart.items',
    ]);
    expect(report.calls.map((fact) => fact.reference.confidence)).toEqual(['high', 'medium']);
    expect(report.claimed.size).toBe(2);
  });

  it('applies project methods, with pathSeparator and without keyArg', () => {
    const report = collect(
      {
        ...STORE,
        'src/use.ts': [
          "import { store } from './store.js';",
          "store.select('session.user');",
          'store.reset();',
          "store.get('user');",
          "store.has('user');",
        ].join('\n'),
      },
      'src/use.ts',
      {
        ...CONFIG,
        methods: [
          { method: 'select', access: 'read', keyArg: 0, pathSeparator: '.' },
          { method: 'reset', access: 'write' },
          { method: 'get', access: 'write', keyArg: 0 },
        ],
      },
    );
    expect(report.calls.map(describeCall)).toEqual([
      'readsState select state:src/store.ts:store#session.user',
      'writesState reset state:src/store.ts:store',
      'writesState get state:src/store.ts:store#user',
      'readsState has state:src/store.ts:store#user',
    ]);
  });

  it('turns built-ins off with disable, or all of them off with builtIns: false', () => {
    const files = {
      ...STORE,
      'src/use.ts': [
        "import { store } from './store.js';",
        "store.has('user');",
        "store.get('user');",
      ].join('\n'),
    };

    const disabled = collect(files, 'src/use.ts', { ...CONFIG, disable: ['has'] });
    expect(disabled.calls.map(describeCall)).toEqual([
      'readsState get state:src/store.ts:store#user',
    ]);
    expect(disabled.claimed.size).toBe(1);

    const none = collect(files, 'src/use.ts', { ...CONFIG, builtIns: false });
    expect(none.calls).toEqual([]);
    expect(none.claimed.size).toBe(0);
  });

  it('lets a project method replace a built-in of the same name', () => {
    const report = collect(
      {
        ...STORE,
        'src/use.ts': "import { store } from './store.js';\nstore.get('user');",
      },
      'src/use.ts',
      { ...CONFIG, methods: [{ method: 'get', access: 'delete', keyArg: 0 }] },
    );
    expect(report.calls.map(describeCall)).toEqual([
      'deletesState get state:src/store.ts:store#user',
    ]);
  });

  describe('dynamic keys', () => {
    const FILES = {
      ...STORE,
      'src/use.ts': [
        "import { store } from './store.js';",
        'declare const key: string;',
        'declare const args: string[];',
        'store.get(key);',
        'store.delete(...args);',
        'store.get();',
      ].join('\n'),
    };

    it('reports them as unresolved observations under the default off', () => {
      const report = collect(FILES, 'src/use.ts');
      expect(report.calls).toEqual([]);
      expect(report.unresolved.map((observation) => observation.method)).toEqual([
        'get',
        'delete',
        'get',
      ]);
      expect(report.unresolved[0]?.reason).toEqual(expect.any(String));
      expect(report.unresolved[0]?.receiver.root).toBe('src/store.ts:store');
      // Still claimed: a dynamic key on state is state, not a registry lookup.
      expect(report.claimed.size).toBe(3);
    });

    it('records them as a wildcard segment under wildcard', () => {
      const report = collect(FILES, 'src/use.ts', { ...CONFIG, dynamicPaths: 'wildcard' });
      expect(report.unresolved).toEqual([]);
      expect(report.calls.map(describeCall)).toEqual([
        'readsState get state:src/store.ts:store#[*]',
        'deletesState delete state:src/store.ts:store#[*]',
        'readsState get state:src/store.ts:store#[*]',
      ]);
      expect(report.calls[0]?.reference.dynamicReason).toEqual(expect.any(String));
    });

    it('treats a dynamic receiver as dynamic too', () => {
      const report = collect(
        {
          ...STORE,
          'src/use.ts': [
            "import { store } from './store.js';",
            'declare const key: string;',
            "store[key].get('user');",
          ].join('\n'),
        },
        'src/use.ts',
      );
      expect(report.calls).toEqual([]);
      expect(report.unresolved.map((observation) => observation.reason)).toEqual([
        expect.any(String),
      ]);
    });
  });

  it('reads numeric keys, element-access method names, and ignores dynamic method names', () => {
    const report = collect(
      {
        ...STORE,
        'src/use.ts': [
          "import { store } from './store.js';",
          'declare const m: string;',
          'store.get(0);',
          "store['has']('user');",
          'store[m]("user");',
          'store.keys();',
        ].join('\n'),
      },
      'src/use.ts',
    );
    expect(report.calls.map(describeCall)).toEqual([
      'readsState get state:src/store.ts:store#["0"]',
      'readsState has state:src/store.ts:store#user',
    ]);
    expect(report.claimed.size).toBe(2);
  });
});
