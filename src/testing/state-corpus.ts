import type { StateConfig } from '../config/state-config.js';

/**
 * A realistic mini-repository with the shared-state accesses a developer would say it contains.
 *
 * The expectations are written from the code's meaning, not from what the tool prints, so the
 * corpus measures the tool instead of echoing it.
 */
export interface StateFixture {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly options?: StateConfig;
  /**
   * Owner to state-path pairs, as `owner -> state:<root>#<path>`. This is what "navigable through
   * the shared state" means, and it does not depend on whether an access reads, writes or deletes.
   */
  readonly pairs: readonly string[];
  /** Observations policy says to report, as `reason | subject`. Everything else stays silent. */
  readonly observations: readonly string[];
  /** The exact state edges, as `type owner -> state:...`. Only for fixtures the tool must get exactly right. */
  readonly edges?: readonly string[];
  /** Present only for a known limit: how the tool currently falls short of `pairs`. */
  readonly limit?: {
    readonly note: string;
    readonly missingPairs: readonly string[];
    readonly extraPairs: readonly string[];
  };
}

const lines = (...rows: string[]): string => rows.join('\n');

const STORE_FILE = lines(
  'export const store: any = {};',
  'export const cache = new Map<string, number>();',
);

const STORE_CONFIG: StateConfig = {
  singletons: [
    { module: 'store.ts', export: 'store' },
    { module: 'store.ts', export: 'cache' },
  ],
};

export const STATE_CORPUS: readonly StateFixture[] = [
  {
    name: 'singleton read and write through its module export',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { store } from './store.js';",
        'export function load() { return store.user; }',
        'export function save(u: unknown) { store.user = u; }',
      ),
    },
    options: STORE_CONFIG,
    pairs: ['use.ts:load -> state:store.ts:store#user', 'use.ts:save -> state:store.ts:store#user'],
    observations: [],
    edges: [
      'readsState use.ts:load -> state:store.ts:store#user',
      'writesState use.ts:save -> state:store.ts:store#user',
    ],
  },
  {
    name: 'a renamed import reaches the same root',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { store as app } from './store.js';",
        'export function load() { return app.user; }',
      ),
    },
    options: STORE_CONFIG,
    pairs: ['use.ts:load -> state:store.ts:store#user'],
    observations: [],
    edges: ['readsState use.ts:load -> state:store.ts:store#user'],
  },
  {
    name: 'a namespace import reaches the singleton through its member',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import * as ns from './store.js';",
        'export function load() { return ns.store.user; }',
      ),
    },
    options: STORE_CONFIG,
    pairs: ['use.ts:load -> state:store.ts:store#user'],
    observations: [],
    edges: ['readsState use.ts:load -> state:store.ts:store#user'],
  },
  {
    name: 'a parameter with the singleton name is not the singleton',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { store } from './store.js';",
        'export function load() { return store.user; }',
        'export function local(store: { user: number }) { return store.user; }',
      ),
    },
    options: STORE_CONFIG,
    pairs: ['use.ts:load -> state:store.ts:store#user'],
    observations: [],
    edges: ['readsState use.ts:load -> state:store.ts:store#user'],
  },
  {
    name: 'an export with the same name from another module is not the singleton',
    files: {
      'store.ts': STORE_FILE,
      'other.ts': 'export const store: any = {};',
      'use.ts': lines(
        "import { store } from './other.js';",
        'export function load() { return store.user; }',
      ),
    },
    options: STORE_CONFIG,
    pairs: [],
    observations: [],
    edges: [],
  },
  {
    name: 'unrelated objects with the same property names are not state',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { store } from './store.js';",
        'export function profile() { const profile = { user: 1 }; profile.user = 2; return profile; }',
        'export function load() { return store.user; }',
      ),
    },
    options: STORE_CONFIG,
    pairs: ['use.ts:load -> state:store.ts:store#user'],
    observations: [],
    edges: ['readsState use.ts:load -> state:store.ts:store#user'],
  },
  {
    name: 'a const alias of the singleton reads the same path',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { store } from './store.js';",
        'const alias = store;',
        'export function load() { return alias.user; }',
      ),
    },
    options: STORE_CONFIG,
    // The module holds a reference to the container, which is a container read; the path is
    // read through the alias.
    pairs: ['use.ts -> state:store.ts:store', 'use.ts:load -> state:store.ts:store#user'],
    observations: [],
    edges: [
      'readsState use.ts -> state:store.ts:store',
      'readsState use.ts:load -> state:store.ts:store#user',
    ],
  },
  {
    name: 'a destructured const reads the path it names',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { store } from './store.js';",
        'export function load() { const { user } = store; return user; }',
      ),
    },
    options: STORE_CONFIG,
    pairs: ['use.ts:load -> state:store.ts:store#user'],
    observations: [],
    edges: ['readsState use.ts:load -> state:store.ts:store#user'],
  },
  {
    name: 'a global assigned through the window is state, and a parameter named after it is not',
    files: {
      'boot.js': 'window.store = { user: null };',
      'use.ts': lines(
        'export {};',
        'export function who() { return window.store.user; }',
        'export function shadow(store: { user: number }) { return store.user; }',
      ),
    },
    pairs: ['boot.js -> state:global#store', 'use.ts:who -> state:global#store.user'],
    observations: [],
    edges: [
      'writesState boot.js -> state:global#store',
      'readsState use.ts:who -> state:global#store.user',
    ],
  },
  {
    name: 'a configured root counts only where its name is free',
    files: {
      'use.ts': lines(
        'export function read() { return __APP_STATE__.user; }',
        'export function local() { const __APP_STATE__ = { user: 1 }; return __APP_STATE__.user; }',
      ),
    },
    options: { roots: ['__APP_STATE__'] },
    pairs: ['use.ts:read -> state:config:__APP_STATE__#user'],
    observations: [],
    edges: ['readsState use.ts:read -> state:config:__APP_STATE__#user'],
  },
  {
    name: 'a computed key is unresolved by default, and a literal key next to it stays exact',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { store } from './store.js';",
        'export function pick(key: string) { return store[key]; }',
        "export function fixed() { return store['user']; }",
      ),
    },
    options: STORE_CONFIG,
    pairs: ['use.ts:fixed -> state:store.ts:store#user'],
    observations: ['dynamic-state-path | store[key]'],
    edges: ['readsState use.ts:fixed -> state:store.ts:store#user'],
  },
  {
    name: 'a constant key resolves to a static path',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { store } from './store.js';",
        "const KEY = 'user';",
        'export function load() { return store[KEY]; }',
      ),
    },
    options: STORE_CONFIG,
    pairs: ['use.ts:load -> state:store.ts:store#user'],
    observations: [],
    edges: ['readsState use.ts:load -> state:store.ts:store#user'],
  },
  {
    name: 'a computed key becomes a wildcard when enabled',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { store } from './store.js';",
        'export function pick(key: string) { return store[key]; }',
      ),
    },
    options: { ...STORE_CONFIG, dynamicPaths: 'wildcard' },
    pairs: ['use.ts:pick -> state:store.ts:store#[*]'],
    observations: [],
    edges: ['readsState use.ts:pick -> state:store.ts:store#[*]'],
  },
  {
    name: 'state methods record reads, writes and deletes through their key',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { cache } from './store.js';",
        "export function fill() { cache.set('user', 1); }",
        "export function look() { return cache.get('user'); }",
        "export function drop() { cache.delete('user'); }",
      ),
    },
    options: STORE_CONFIG,
    pairs: [
      'use.ts:drop -> state:store.ts:cache#user',
      'use.ts:fill -> state:store.ts:cache#user',
      'use.ts:look -> state:store.ts:cache#user',
    ],
    observations: [],
    edges: [
      'deletesState use.ts:drop -> state:store.ts:cache#user',
      'writesState use.ts:fill -> state:store.ts:cache#user',
      'readsState use.ts:look -> state:store.ts:cache#user',
    ],
  },
  {
    name: 'a state method called with a computed key is unresolved by default',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { cache } from './store.js';",
        'export function look(key: string) { return cache.get(key); }',
      ),
    },
    options: STORE_CONFIG,
    pairs: [],
    observations: ['dynamic-state-path | cache.get(key)'],
    edges: [],
  },

  {
    name: 'an update reads its path and writes it back',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { store } from './store.js';",
        "export function bump() { store.update('count', (n: number) => n + 1); }",
      ),
    },
    options: STORE_CONFIG,
    pairs: ['use.ts:bump -> state:store.ts:store#count'],
    observations: [],
    edges: [
      'readsState use.ts:bump -> state:store.ts:store#count',
      'writesState use.ts:bump -> state:store.ts:store#count',
    ],
  },

  // ── Known limits: where the tool falls short of what the code means ──────────────────────────

  {
    name: 'a state object passed to a helper is not followed into it',
    files: {
      'store.ts': STORE_FILE,
      'helper.ts': 'export function helper(s: any) { s.user = 1; }',
      'use.ts': lines(
        "import { store } from './store.js';",
        "import { helper } from './helper.js';",
        'export function run() { helper(store); }',
      ),
    },
    options: STORE_CONFIG,
    pairs: ['helper.ts:helper -> state:store.ts:store#user', 'use.ts:run -> state:store.ts:store'],
    observations: [],
    limit: {
      note: 'Parameters are not followed, so a write through a passed-in state object is missed.',
      missingPairs: ['helper.ts:helper -> state:store.ts:store#user'],
      extraPairs: [],
    },
  },
  {
    name: 'a let binding of the singleton is not followed',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { store } from './store.js';",
        'let alias = store;',
        'export function save() { alias.user = 1; }',
      ),
    },
    options: STORE_CONFIG,
    pairs: ['use.ts -> state:store.ts:store', 'use.ts:save -> state:store.ts:store#user'],
    observations: [],
    limit: {
      note: 'Only const bindings are followed, since a let binding can be reassigned.',
      missingPairs: ['use.ts:save -> state:store.ts:store#user'],
      extraPairs: [],
    },
  },
  {
    name: 'a singleton stored inside an object literal is not followed',
    files: {
      'store.ts': STORE_FILE,
      'use.ts': lines(
        "import { store } from './store.js';",
        'const holder = { inner: store };',
        'export function save() { holder.inner.user = 1; }',
      ),
    },
    options: STORE_CONFIG,
    pairs: ['use.ts -> state:store.ts:store', 'use.ts:save -> state:store.ts:store#user'],
    observations: [],
    limit: {
      note: 'A reference held in an object literal is not traced to its property.',
      missingPairs: ['use.ts:save -> state:store.ts:store#user'],
      extraPairs: [],
    },
  },
  {
    name: 'a default export of the singleton re-exports it without reading it',
    files: {
      'store.ts': lines('const store: any = {};', 'export default store;'),
      'use.ts': lines(
        "import shared from './store.js';",
        'export function load() { return shared.user; }',
      ),
    },
    options: { singletons: [{ module: 'store.ts', export: 'default' }] },
    pairs: ['use.ts:load -> state:store.ts:default#user'],
    observations: [],
    edges: ['readsState use.ts:load -> state:store.ts:default#user'],
  },
  {
    name: 'a default export of a property path still reads it',
    files: {
      'store.ts': lines('export const store: any = {};', 'export default store.user;'),
    },
    options: STORE_CONFIG,
    pairs: ['store.ts -> state:store.ts:store#user'],
    observations: [],
    edges: ['readsState store.ts -> state:store.ts:store#user'],
  },
];
