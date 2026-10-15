import type { LoaderProtocol } from '../analyzer/loader-protocols.js';

/**
 * Module loads with the connections a developer would name. Expectations are written from the
 * code's meaning before the tool runs, so the corpus measures the tool.
 *
 * Edges are `from -> to [loadKind]`, where `none` marks a static import or `require`, which carry
 * no load kind. Observations are `owner [loadKind]`, one per dynamic load the tool cannot resolve.
 */
export interface ModuleLoadFixture {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly loaders?: readonly LoaderProtocol[];
  readonly edges: readonly string[];
  readonly observations: readonly string[];
  /** A real connection the tool does not draw yet. It is excluded from `edges` and must stay absent. */
  readonly limit?: {
    readonly note: string;
    readonly missing: readonly string[];
  };
}

const lines = (...rows: string[]): string => rows.join('\n');

export const MODULE_LOAD_CORPUS: readonly ModuleLoadFixture[] = [
  {
    name: 'dynamic imports from functions resolve to the file they load',
    files: {
      'a.ts': 'export const a = 1;',
      'b.ts': 'export const b = 2;',
      'main.ts': lines(
        "export const loadA = () => import('./a.js');",
        "export const loadB = () => import('./b.js');",
      ),
    },
    edges: ['main.ts:loadA -> a.ts [import-expression]', 'main.ts:loadB -> b.ts [import-expression]'],
    observations: [],
  },
  {
    name: 'a dynamic specifier is an observation, not an edge',
    files: {
      'a.ts': 'export const a = 1;',
      'main.ts': 'export const load = (name: string) => import(`./${name}.js`);',
    },
    edges: [],
    observations: ['main.ts:load [import-expression]'],
  },
  {
    name: 'external packages and missing local files stay silent',
    files: {
      'main.ts': lines(
        "export const pkg = () => import('left-pad');",
        "export const missing = () => import('./missing.js');",
      ),
    },
    edges: [],
    observations: [],
  },
  {
    name: 'a worker and a URL relative to import.meta resolve to their files',
    files: {
      'worker.ts': 'export {};',
      'util.ts': 'export const u = 1;',
      'main.ts': lines(
        "export const spawn = () => new Worker(new URL('./worker.js', import.meta.url));",
        "export const asset = () => new URL('./util.js', import.meta.url);",
        "export const foreign = () => new URL('./util.js', 'https://example.com');",
      ),
    },
    edges: ['main.ts:spawn -> worker.ts [worker]', 'main.ts:asset -> util.ts [url]'],
    observations: [],
  },
  {
    name: 'a static import keeps its edge, and a function-level load adds its own',
    files: {
      'util.ts': 'export const help = 1;',
      'main.ts': lines(
        "import { help } from './util.js';",
        "export const lazy = () => import('./util.js');",
        'export const kept = help;',
      ),
    },
    edges: ['main.ts -> util.ts [none]', 'main.ts:lazy -> util.ts [import-expression]'],
    observations: [],
  },
  {
    name: 'a top-level dynamic import of an already-imported file adds no edge',
    files: {
      'util.ts': 'export const help = 1;',
      'main.ts': lines(
        "import { help } from './util.js';",
        "export const top = await import('./util.js');",
        'export const kept = help;',
      ),
    },
    edges: ['main.ts -> util.ts [none]'],
    observations: [],
  },
  {
    name: 'configured plain and receiver-scoped loaders resolve, and a non-matching receiver is silent',
    files: {
      'plugins-api.ts': 'export const api = 1;',
      'util.ts': 'export const u = 1;',
      'main.ts': lines(
        'declare function loadPlugin(specifier: string): unknown;',
        'declare const plugins: { load(specifier: string): unknown };',
        'declare const other: { load(specifier: string): unknown };',
        "export const viaPlain = () => loadPlugin('./plugins-api.js');",
        "export const viaPlugins = () => plugins.load('./util.js');",
        "export const viaOther = () => other.load('./util.js');",
      ),
    },
    loaders: [
      { function: 'loadPlugin', specifierArg: 0 },
      { function: 'load', specifierArg: 0, receiver: { names: ['plugins'] } },
    ],
    edges: [
      'main.ts:viaPlain -> plugins-api.ts [loader]',
      'main.ts:viaPlugins -> util.ts [loader]',
    ],
    observations: [],
  },
  {
    name: 'a receiver-scoped loader matches by the receiver type',
    files: {
      'util.ts': 'export const u = 1;',
      'main.ts': lines(
        'class PluginHost { load(specifier: string): unknown { return specifier; } }',
        'declare const host: PluginHost;',
        "export const viaHost = () => host.load('./util.js');",
      ),
    },
    loaders: [{ function: 'load', specifierArg: 0, receiver: { types: ['PluginHost'] } }],
    edges: ['main.ts:viaHost -> util.ts [loader]'],
    observations: [],
  },
  {
    name: 'a configured loader with a computed specifier is an observation',
    files: {
      'main.ts': lines(
        'declare function loadPlugin(specifier: string): unknown;',
        'export const byName = (name: string) => loadPlugin(name);',
      ),
    },
    loaders: [{ function: 'loadPlugin', specifierArg: 0 }],
    edges: [],
    observations: ['main.ts:byName [loader]'],
  },
  {
    name: 'known limit: a loader called through an alias is not matched to its receiver',
    files: {
      'util.ts': 'export const u = 1;',
      'main.ts': lines(
        'declare const plugins: { load(specifier: string): unknown };',
        'export const viaAlias = () => {',
        '  const p = plugins;',
        "  return p.load('./util.js');",
        '};',
      ),
    },
    loaders: [{ function: 'load', specifierArg: 0, receiver: { names: ['plugins'] } }],
    edges: ['main.ts:viaAlias -> util.ts [loader]'],
    observations: [],
    limit: {
      note: 'the receiver is matched by its written name, so an alias of a configured object is missed',
      missing: ['main.ts:viaAlias -> util.ts [loader]'],
    },
  },
];