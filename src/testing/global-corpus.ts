import type { RepositoryAnalysisOptions } from '../analyzer/js-ts-analyzer.js';

/**
 * A realistic mini-repository with the global connections a developer would say it contains.
 *
 * Expectations are written from the code's meaning: a read of a global that exactly one file
 * declares connects to it; a shadowed, parameter, module-scope or same-file name does not; a
 * write is a fact, not an edge; a name with two declarations is reported, not guessed.
 */
export interface GlobalFixture {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly options?: RepositoryAnalysisOptions;
  /** Caller to target pairs that name a global, as `caller -> target`, sorted. */
  readonly pairs: readonly string[];
  /** Observations policy says to report, as `reason | subject`. Everything else stays silent. */
  readonly observations: readonly string[];
  /** Every references edge, as `references from -> to`. Exact for every fixture. */
  readonly edges: readonly string[];
}

const lines = (...rows: string[]): string => rows.join('\n');

export const GLOBAL_CORPUS: readonly GlobalFixture[] = [
  {
    name: 'a script-scope function is called from another module',
    files: {
      'lib.js': 'function boot() {}',
      'main.js': 'export function run() { boot(); }',
    },
    pairs: ['main.js:run -> lib.js:boot'],
    observations: [],
    edges: ['references main.js -> lib.js', 'references main.js:run -> lib.js:boot'],
  },
  {
    name: 'several callers each link to the same global',
    files: {
      'lib.js': 'function boot() {}',
      'a.js': 'export function one() { boot(); }',
      'b.js': 'export function two() { boot(); }',
    },
    pairs: ['a.js:one -> lib.js:boot', 'b.js:two -> lib.js:boot'],
    observations: [],
    edges: [
      'references a.js -> lib.js',
      'references a.js:one -> lib.js:boot',
      'references b.js -> lib.js',
      'references b.js:two -> lib.js:boot',
    ],
  },
  {
    name: 'a global assigned through the window is read as a global variable',
    files: {
      'config.js': 'window.appConfig = { debug: true };',
      'main.js': 'export function show() { return appConfig.debug; }',
    },
    pairs: ['main.js:show -> config.js:appConfig'],
    observations: [],
    edges: ['references main.js -> config.js', 'references main.js:show -> config.js:appConfig'],
  },
  {
    name: 'a global read through the window object is linked',
    files: {
      'lib.js': 'function boot() {}',
      'main.js': 'export function run() { window.boot(); }',
    },
    pairs: ['main.js:run -> lib.js:boot'],
    observations: [],
    edges: ['references main.js -> lib.js', 'references main.js:run -> lib.js:boot'],
  },
  {
    name: 'a global reached through a globalThis alias is linked',
    files: {
      'lib.js': 'const root = globalThis;\nroot.Shared = function () {};',
      'main.js': 'export function run() { Shared(); }',
    },
    pairs: ['main.js:run -> lib.js:Shared'],
    observations: [],
    edges: ['references main.js -> lib.js', 'references main.js:run -> lib.js:Shared'],
  },
  {
    name: 'an exported function from a module is not a global',
    files: {
      'lib.js': 'export function boot() {}',
      'main.js': 'export function run() { boot(); }',
    },
    pairs: [],
    observations: [],
    edges: [],
  },
  {
    name: 'a local that shadows the global is not linked',
    files: {
      'lib.js': 'function boot() {}',
      'main.js': 'export function run() { const boot = () => 1; return boot(); }',
    },
    pairs: [],
    observations: [],
    edges: [],
  },
  {
    name: 'a parameter with the global name is not linked',
    files: {
      'lib.js': 'function boot() {}',
      'main.js': 'export function run(boot) { return boot(); }',
    },
    pairs: [],
    observations: [],
    edges: [],
  },
  {
    name: 'a module-scope name that matches a global is not linked',
    files: {
      'lib.js': 'function boot() {}',
      'helper.js': 'export const boot = () => 1;\nexport function use() { return boot(); }',
    },
    pairs: [],
    observations: [],
    edges: [],
  },
  {
    name: 'a call inside the declaring file makes no edge',
    files: {
      'lib.js': 'function boot() {}\nfunction go() { boot(); }',
    },
    pairs: [],
    observations: [],
    edges: [],
  },
  {
    name: 'a declaration in a CommonJS file is not a global',
    files: {
      'a.js': 'function helper() {}\nmodule.exports = { helper };',
      'b.js': 'export function run() { helper(); }',
    },
    pairs: [],
    observations: [],
    edges: [],
  },
  {
    name: 'two files declare the same global, so the use is reported, not guessed',
    files: {
      'a.js': 'function init() {}',
      'b.js': 'function init() {}',
      'main.js': 'export function run() { init(); }',
    },
    pairs: [],
    observations: ['ambiguous-global | init'],
    edges: [],
  },
  {
    name: 'globals.targets chooses the owner of a duplicated global',
    files: {
      'a.js': 'function init() {}',
      'b.js': 'function init() {}',
      'main.js': 'export function run() { init(); }',
    },
    options: { globals: { targets: { init: 'a.js' } } },
    pairs: ['main.js:run -> a.js:init'],
    observations: [],
    edges: ['references main.js -> a.js', 'references main.js:run -> a.js:init'],
  },
  {
    name: 'a write through the window is a fact, not an edge',
    files: {
      'lib.js': 'var counter = 0;',
      'main.js': 'export function bump() { window.counter = 1; }',
    },
    pairs: [],
    observations: [],
    edges: [],
  },
  {
    name: 'a dynamic property of the window names no global',
    files: {
      'lib.js': 'function boot() {}',
      'main.js': 'export function run(name) { window[name](); }',
    },
    pairs: [],
    observations: [],
    edges: [],
  },
  {
    name: 'a name that no file declares is silent',
    files: {
      'main.js': 'export function run() { notDefinedAnywhere(); }',
    },
    pairs: [],
    observations: [],
    edges: [],
  },
  {
    name: 'a global declared in a typed declare-global block is linked',
    files: {
      'types.ts': lines('export {};', 'declare global { function ext(): void; }'),
      'main.ts': 'export function run() { ext(); }',
    },
    pairs: ['main.ts:run -> types.ts:ext'],
    observations: [],
    edges: ['references main.ts -> types.ts', 'references main.ts:run -> types.ts:ext'],
  },
];
