import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateConfig } from '../config/state-config.js';
import { statePathId } from '../graph.js';
import {
  callArguments,
  createRepositoryFixture,
  type RepositoryFixture,
} from '../testing/repository-fixture.js';
import { collectGlobalSymbols } from './global-symbols.js';
import { StateRootResolver, type StateReference } from './state-roots.js';

// Each case builds a TypeScript program; the default limit is tight under a parallel run.
vi.setConfig({ testTimeout: 30_000 });

/** Script files only exist as scripts under some settings, so every case runs under both. */
const TSCONFIGS: ReadonlyArray<readonly [string, Record<string, unknown> | undefined]> = [
  ['no tsconfig (node16 defaults)', undefined],
  ['esnext + bundler', { module: 'ESNext', moduleResolution: 'Bundler' }],
];

/** The probe is declared so fixtures type-check; its argument is the expression under test. */
const PROBE = 'declare function probe(value: unknown): void;\n';

describe.each(TSCONFIGS)('Phase 6.3: state root resolution [%s]', (_label, compilerOptions) => {
  const fixtures: RepositoryFixture[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });

  interface Resolved {
    /** The id of each probed expression's state path, or `undefined` when it is not state */
    readonly ids: ReadonlyArray<string | undefined>;
    readonly references: ReadonlyArray<StateReference | undefined>;
    readonly resolver: StateRootResolver;
  }

  /** Resolve every `probe(...)` argument in `probeFile`, in source order. */
  function resolveProbes(
    files: Record<string, string>,
    probeFile: string,
    config: StateConfig = {},
  ): Resolved {
    const fixture = createRepositoryFixture({ 'probe.d.ts': PROBE, ...files }, compilerOptions);
    fixtures.push(fixture);
    const { repository } = fixture;
    const resolver = new StateRootResolver(repository, collectGlobalSymbols(repository), config);
    const references = callArguments(repository, probeFile).map((argument) =>
      resolver.resolve(argument),
    );
    return {
      ids: references.map((reference) =>
        reference ? statePathId(reference.root, reference.segments) : undefined,
      ),
      references,
      resolver,
    };
  }

  describe('global state', () => {
    const GLOBALS = {
      'src/boot.js':
        'window.store = { user: null };\nwindow.App = {};\nwindow.App.init = function () {};\nwindow.start = function () {};',
      'src/legacy.js': 'var appState = { count: 0 };\nfunction helper() {}',
    };

    it('resolves every name of the global object to one root', () => {
      const { ids } = resolveProbes(
        {
          ...GLOBALS,
          'src/use.ts': [
            'export {};',
            'probe(window.store.user);',
            'probe(globalThis.store);',
            "probe(self['store'].user);",
            'const root = globalThis;',
            'probe(root.store.user);',
          ].join('\n'),
        },
        'src/use.ts',
      );
      expect(ids).toEqual([
        'state:global#store.user',
        'state:global#store',
        'state:global#store.user',
        'state:global#store.user',
      ]);
    });

    it('tracks assigned names and script variables, not functions or runtime built-ins', () => {
      const { ids } = resolveProbes(
        {
          ...GLOBALS,
          'src/use.ts': [
            'export {};',
            'probe(window.App.version);',
            'probe(window.start);',
            'probe(window.location.href);',
            'probe(window);',
          ].join('\n'),
          'src/script.js': 'probe(appState.count);\nprobe(helper);\nprobe(store.user);',
        },
        'src/use.ts',
      );
      expect(ids).toEqual(['state:global#App.version', undefined, undefined, undefined]);
    });

    it('resolves bare names of global variables', () => {
      const { ids } = resolveProbes(
        {
          ...GLOBALS,
          'src/script.js': 'probe(appState.count);\nprobe(helper);\nprobe(store.user);',
        },
        'src/script.js',
      );
      expect(ids).toEqual(['state:global#appState.count', undefined, 'state:global#store.user']);
    });

    it('ignores local bindings that shadow a global or the global object', () => {
      const { ids } = resolveProbes(
        {
          ...GLOBALS,
          'src/use.ts': [
            'export {};',
            'function a(window: { store: unknown }) { probe(window.store); }',
            'function b() { const appState = { count: 1 }; probe(appState.count); }',
            'function c(store: { user: unknown }) { probe(store.user); }',
          ].join('\n'),
        },
        'src/use.ts',
      );
      expect(ids).toEqual([undefined, undefined, undefined]);
    });

    it('limits tracking to listed names, which need no assignment', () => {
      const { ids } = resolveProbes(
        {
          ...GLOBALS,
          'src/use.ts': [
            'export {};',
            'probe(window.store.user);',
            'probe(window.App.version);',
            'probe(window.__INITIAL__.page);',
            'probe(__INITIAL__.page);',
          ].join('\n'),
        },
        'src/use.ts',
        { globals: ['store', '__INITIAL__'] },
      );
      expect(ids).toEqual([
        'state:global#store.user',
        undefined,
        'state:global#__INITIAL__.page',
        'state:global#__INITIAL__.page',
      ]);
    });

    it('tracks nothing under the global object when globals is false', () => {
      const { ids } = resolveProbes(
        { ...GLOBALS, 'src/use.ts': 'export {};\nprobe(window.store.user);\nprobe(appState);' },
        'src/use.ts',
        { globals: false },
      );
      expect(ids).toEqual([undefined, undefined]);
    });
  });

  describe('configured roots', () => {
    it('resolves a free name and follows a const alias of it', () => {
      const { ids, references } = resolveProbes(
        {
          'src/env.d.ts': 'declare const __APP__: { theme: string };',
          'src/use.ts': [
            'export {};',
            'probe(__APP__.theme);',
            'probe(__APP__);',
            'const app = __APP__;',
            'probe(app.theme);',
          ].join('\n'),
        },
        'src/use.ts',
        { roots: ['__APP__'] },
      );
      expect(ids).toEqual([
        'state:config:__APP__#theme',
        'state:config:__APP__',
        'state:config:__APP__#theme',
      ]);
      expect(references[0]).toMatchObject({ rootKind: 'configured', evidence: 'config' });
      expect(references[2]?.confidence).toBe('high');
    });

    it('treats a declare global in a source file as a type, not a binding', () => {
      const { ids } = resolveProbes(
        {
          'src/globals.ts': 'export {};\ndeclare global { const __APP__: { theme: string }; }',
          'src/use.ts': 'export {};\nprobe(__APP__.theme);',
        },
        'src/use.ts',
        { roots: ['__APP__'] },
      );
      expect(ids).toEqual(['state:config:__APP__#theme']);
    });

    it('does not resolve a repository binding with the same name', () => {
      const { ids } = resolveProbes(
        {
          'src/use.ts': [
            'export {};',
            'function f(__APP__: { theme: string }) { probe(__APP__.theme); }',
            'const other = { theme: 1 };',
            'probe(other.theme);',
          ].join('\n'),
        },
        'src/use.ts',
        { roots: ['__APP__'] },
      );
      expect(ids).toEqual([undefined, undefined]);
    });
  });

  describe('singletons', () => {
    const STORE = {
      'src/store.ts': [
        'export const store = { cart: { items: [] as string[] }, user: null };',
        'probe(store.cart);',
      ].join('\n'),
      'src/default-state.ts': 'const state = { theme: "dark" };\nexport default state;',
    };
    const CONFIG: StateConfig = {
      singletons: [
        { module: 'src/store.ts', export: 'store' },
        { module: 'src/default-state.ts', export: 'default' },
      ],
    };

    it('resolves the export inside its own module', () => {
      const { ids, references } = resolveProbes(STORE, 'src/store.ts', CONFIG);
      expect(ids).toEqual(['state:src/store.ts:store#cart']);
      expect(references[0]).toMatchObject({ rootKind: 'singleton', confidence: 'high' });
    });

    it('resolves renamed, namespace and default imports to the same root', () => {
      const { ids } = resolveProbes(
        {
          ...STORE,
          'src/use.ts': [
            "import { store as s } from './store.js';",
            "import * as ns from './store.js';",
            "import theme from './default-state.js';",
            'probe(s.cart.items);',
            'probe(ns.store.cart);',
            'probe(ns.store);',
            'probe(theme.theme);',
          ].join('\n'),
        },
        'src/use.ts',
        CONFIG,
      );
      expect(ids).toEqual([
        'state:src/store.ts:store#cart.items',
        'state:src/store.ts:store#cart',
        'state:src/store.ts:store',
        'state:src/default-state.ts:default#theme',
      ]);
    });

    it('follows const aliases and destructuring at medium confidence', () => {
      const { ids, references } = resolveProbes(
        {
          ...STORE,
          'src/use.ts': [
            "import { store } from './store.js';",
            'const cart = store.cart;',
            'probe(cart.items);',
            'const { cart: { items } } = store;',
            'probe(items);',
            'const same = store;',
            'probe(same.user);',
          ].join('\n'),
        },
        'src/use.ts',
        CONFIG,
      );
      expect(ids).toEqual([
        'state:src/store.ts:store#cart.items',
        'state:src/store.ts:store#cart.items',
        'state:src/store.ts:store#user',
      ]);
      expect(references.map((reference) => reference?.confidence)).toEqual([
        'medium',
        'medium',
        'high',
      ]);
    });

    it('does not follow let bindings, parameters or unrelated objects', () => {
      const { ids } = resolveProbes(
        {
          ...STORE,
          'src/use.ts': [
            "import { store } from './store.js';",
            'let later = store.cart;',
            'probe(later.items);',
            'function f(store: { cart: unknown }) { probe(store.cart); }',
            'const lookalike = { cart: 1 };',
            'probe(lookalike.cart);',
          ].join('\n'),
        },
        'src/use.ts',
        CONFIG,
      );
      expect(ids).toEqual([undefined, undefined, undefined]);
    });

    it('does not resolve a same-named export of another module', () => {
      const { ids } = resolveProbes(
        {
          ...STORE,
          'src/other-store.ts': 'export const store = { cart: 1 };',
          'src/use.ts': "import { store } from './other-store.js';\nprobe(store.cart);",
        },
        'src/use.ts',
        CONFIG,
      );
      expect(ids).toEqual([undefined]);
    });

    it('reports singletons that match no export', () => {
      const { resolver } = resolveProbes(STORE, 'src/store.ts', {
        singletons: [
          { module: 'src/missing.ts', export: 'store' },
          { module: 'src/store.ts', export: 'nothing' },
        ],
      });
      expect(resolver.problems).toEqual([
        {
          path: 'state.singletons[0].module',
          message: '"src/missing.ts" is not an analyzed file; entry ignored',
        },
        {
          path: 'state.singletons[1].export',
          message: '"src/store.ts" has no export "nothing"; entry ignored',
        },
      ]);
    });
  });

  describe('computed properties', () => {
    it('resolves static keys and marks dynamic ones', () => {
      const { ids, references } = resolveProbes(
        {
          'src/store.ts': 'export const store: Record<string, unknown> = {};',
          'src/use.ts': [
            "import { store } from './store.js';",
            "const KEY = 'cart';",
            'declare const key: string;',
            'probe(store[KEY]);',
            'probe(store[0]);',
            'probe(store[key]);',
          ].join('\n'),
        },
        'src/use.ts',
        { singletons: [{ module: 'src/store.ts', export: 'store' }] },
      );
      expect(ids).toEqual([
        'state:src/store.ts:store#cart',
        'state:src/store.ts:store#["0"]',
        'state:src/store.ts:store#[*]',
      ]);
      expect(references[2]?.dynamicReason).toEqual(expect.any(String));
    });

    it('does not guess which global a dynamic key names', () => {
      const { ids } = resolveProbes(
        {
          'src/boot.js': 'window.store = {};',
          'src/use.ts': 'export {};\ndeclare const key: string;\nprobe(window[key]);',
        },
        'src/use.ts',
      );
      expect(ids).toEqual([undefined]);
    });
  });
});