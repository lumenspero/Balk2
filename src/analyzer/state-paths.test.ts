import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StateConfig } from '../config/state-config.js';
import { statePathId } from '../graph.js';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import { collectGlobalSymbols } from './global-symbols.js';
import { collectStateAccesses, type StateAccessFact } from './state-paths.js';
import { StateRootResolver } from './state-roots.js';

vi.setConfig({ testTimeout: 30_000 });

const TSCONFIGS: ReadonlyArray<readonly [string, Record<string, unknown> | undefined]> = [
  ['no tsconfig (node16 defaults)', undefined],
  ['esnext + bundler', { module: 'ESNext', moduleResolution: 'Bundler' }],
];

const STORE = {
  'src/store.ts': [
    'export const store: Record<string, any> = {',
    '  user: null, count: 0, flag: false, cache: {}, cart: { items: [] }, items: [],',
    '  get(key: string): unknown { return key; },',
    '};',
  ].join('\n'),
  'src/lib.d.ts': 'declare function render(value: unknown): void;',
};
const CONFIG: StateConfig = { singletons: [{ module: 'src/store.ts', export: 'store' }] };
const ROOT = 'src/store.ts:store';

describe.each(TSCONFIGS)('Phase 6.4: state path extraction [%s]', (_label, compilerOptions) => {
  const fixtures: RepositoryFixture[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });

  function accesses(
    files: Record<string, string>,
    file: string,
    config: StateConfig = CONFIG,
  ): StateAccessFact[] {
    const fixture = createRepositoryFixture({ ...STORE, ...files }, compilerOptions);
    fixtures.push(fixture);
    const { repository } = fixture;
    const resolver = new StateRootResolver(repository, collectGlobalSymbols(repository), config);
    const sourceFile = repository.sourceFiles.get(file);
    if (!sourceFile) throw new Error(`No source file ${file}`);
    return collectStateAccesses(sourceFile, file, resolver);
  }

  /** `relationship:operation path` for each fact, in source order. */
  function lines(facts: readonly StateAccessFact[]): string[] {
    return facts.map(
      (fact) =>
        `${fact.relationship}:${fact.operation} ${statePathId(fact.reference.root, fact.reference.segments)}`,
    );
  }

  const use = (body: string[]): Record<string, string> => ({
    'src/use.ts': ["import { store } from './store.js';", ...body].join('\n'),
  });

  it('classifies reads, assignments, compound assignments, increments and deletes', () => {
    const facts = accesses(
      use([
        'export function run(): void {',
        '  render(store.user);',
        '  store.user = null;',
        '  store.count += 1;',
        '  store.count++;',
        '  --store.count;',
        '  store.flag ||= true;',
        '  delete store.cache;',
        '}',
      ]),
      'src/use.ts',
    );
    expect(lines(facts)).toEqual([
      `readsState:read state:${ROOT}#user`,
      `writesState:assign state:${ROOT}#user`,
      `readsState:compound-assign state:${ROOT}#count`,
      `writesState:compound-assign state:${ROOT}#count`,
      `readsState:increment state:${ROOT}#count`,
      `writesState:increment state:${ROOT}#count`,
      `readsState:increment state:${ROOT}#count`,
      `writesState:increment state:${ROOT}#count`,
      `readsState:compound-assign state:${ROOT}#flag`,
      `writesState:compound-assign state:${ROOT}#flag`,
      `deletesState:delete state:${ROOT}#cache`,
    ]);
    expect(new Set(facts.map((fact) => fact.owner))).toEqual(new Set(['src/use.ts:run']));
  });

  it('records only the outermost expression of a property chain', () => {
    const facts = accesses(
      use([
        'store.cart.items = [];',
        '(store.cart as any).items = [];',
        'render(store.cart!.items);',
      ]),
      'src/use.ts',
    );
    expect(lines(facts)).toEqual([
      `writesState:assign state:${ROOT}#cart.items`,
      `writesState:assign state:${ROOT}#cart.items`,
      `readsState:read state:${ROOT}#cart.items`,
    ]);
  });

  it('distinguishes reading the container from reading a property', () => {
    const facts = accesses(use(['render(store);', 'render(store.cart);']), 'src/use.ts');
    expect(lines(facts)).toEqual([
      `readsState:read state:${ROOT}`,
      `readsState:read state:${ROOT}#cart`,
    ]);
  });

  it('does not treat calls as data access, but reads state passed as an argument', () => {
    const facts = accesses(
      use([
        'store.items.push(1);',
        "store.get('user');",
        'new store.Thing();',
        'render(store.cart);',
      ]),
      'src/use.ts',
    );
    expect(lines(facts)).toEqual([`readsState:read state:${ROOT}#cart`]);
  });

  it('reads each const-destructured path instead of the container', () => {
    const facts = accesses(
      use(['const { cart, user: { name } } = store;', 'const { count: total } = (store);']),
      'src/use.ts',
    );
    expect(lines(facts)).toEqual([
      `readsState:read state:${ROOT}#cart`,
      `readsState:read state:${ROOT}#user.name`,
      `readsState:read state:${ROOT}#count`,
    ]);
  });

  it('reads the container when destructuring cannot be followed', () => {
    const facts = accesses(
      use(['const { ...rest } = store;', 'let { cart } = store;']),
      'src/use.ts',
    );
    expect(lines(facts)).toEqual([
      `readsState:read state:${ROOT}`,
      `readsState:read state:${ROOT}`,
    ]);
  });

  it('writes destructuring-assignment and for...of targets', () => {
    const facts = accesses(
      use([
        'declare const source: { a: number };',
        'declare const values: number[];',
        '({ a: store.x } = source);',
        '[store.y] = values;',
        'for (store.z of values) {}',
      ]),
      'src/use.ts',
    );
    expect(lines(facts)).toEqual([
      `writesState:assign state:${ROOT}#x`,
      `writesState:assign state:${ROOT}#y`,
      `writesState:assign state:${ROOT}#z`,
    ]);
  });

  it('follows aliases to the path they name', () => {
    const facts = accesses(use(['const cart = store.cart;', 'cart.items = [];']), 'src/use.ts');
    expect(lines(facts)).toEqual([
      `readsState:read state:${ROOT}#cart`,
      `writesState:assign state:${ROOT}#cart.items`,
    ]);
    expect(facts.map((fact) => fact.reference.confidence)).toEqual(['high', 'medium']);
  });

  it('keeps computed properties as null segments for the caller to decide', () => {
    const facts = accesses(
      use(['declare const key: string;', 'store[key] = 1;', 'render(store.cache[key].value);']),
      'src/use.ts',
    );
    expect(lines(facts)).toEqual([
      `writesState:assign state:${ROOT}#[*]`,
      `readsState:read state:${ROOT}#cache[*].value`,
    ]);
    expect(facts.every((fact) => fact.reference.dynamicReason !== undefined)).toBe(true);
  });

  it('attributes accesses to their enclosing owner', () => {
    const facts = accesses(
      use([
        'render(store.user);',
        'export class Cart { clear(): void { store.cart.items = []; } }',
        'export const reset = (): void => { store.count = 0; };',
      ]),
      'src/use.ts',
    );
    expect(facts.map((fact) => fact.owner)).toEqual([
      'src/use.ts',
      'src/use.ts:Cart.clear',
      'src/use.ts:reset',
    ]);
  });

  it('ignores declarations, type positions, exports and unrelated objects', () => {
    const facts = accesses(
      use([
        'export { store };',
        'type Store = typeof store;',
        'const other: Store = { user: 1 };',
        'other.user = 2;',
        'function f(store: { user: number }): void { store.user = 1; }',
      ]),
      'src/use.ts',
    );
    expect(lines(facts)).toEqual([]);
  });

  it('writes global state through assignment and bare script variables', () => {
    const facts = accesses(
      {
        'src/boot.js': [
          'window.store = { user: null };',
          'var appState = { count: 0 };',
          'appState.count = 1;',
          'render(appState);',
        ].join('\n'),
      },
      'src/boot.js',
      {},
    );
    expect(lines(facts)).toEqual([
      'writesState:assign state:global#store',
      'writesState:assign state:global#appState.count',
      'readsState:read state:global#appState',
    ]);
  });
});