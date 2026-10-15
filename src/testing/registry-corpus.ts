import type { RegistryProtocolOptions } from '../analyzer/registry-protocols.js';

/**
 * A realistic mini-repository with the registry connections a developer would say it contains.
 *
 * The expectations are written from the code's meaning, not from what the tool prints, so the
 * corpus measures the tool instead of echoing it.
 */
export interface RegistryFixture {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly options?: RegistryProtocolOptions;
  /**
   * Caller to target pairs that share a registry key, as `caller -> target`. This is what
   * "navigable through the registry" means, and it does not depend on how keys are named.
   */
  readonly pairs: readonly string[];
  /** Observations policy says to report, as `reason | subject`. Everything else stays silent. */
  readonly observations: readonly string[];
  /** The exact registry edges, as `type from -> to`. Only for fixtures the tool must get exactly right. */
  readonly edges?: readonly string[];
  /** Present only for a known limit: how the tool currently falls short of `pairs`. */
  readonly limit?: {
    readonly note: string;
    readonly missingPairs: readonly string[];
    readonly extraPairs: readonly string[];
  };
}

const lines = (...rows: string[]): string => rows.join('\n');

export const REGISTRY_CORPUS: readonly RegistryFixture[] = [
  {
    name: 'container: classes registered on a Map and looked up',
    files: {
      'user.ts': 'export class User {}',
      'order.ts': 'export class Order {}',
      'container.ts': lines(
        "import { User } from './user.js';",
        "import { Order } from './order.js';",
        'export const container = new Map<string, unknown>();',
        "container.set('user', User);",
        "container.set('order', Order);",
        "export function loadUser(): unknown { return container.get('user'); }",
        "export function loadOrder(): unknown { return container.get('order'); }",
      ),
    },
    pairs: ['container.ts:loadUser -> user.ts:User', 'container.ts:loadOrder -> order.ts:Order'],
    observations: [],
    edges: [
      'registers registry:container.ts:container#order -> order.ts:Order',
      'registers registry:container.ts:container#user -> user.ts:User',
      'resolves container.ts:loadOrder -> registry:container.ts:container#order',
      'resolves container.ts:loadUser -> registry:container.ts:container#user',
    ],
  },
  {
    name: 'two registries share a key name without mixing their targets',
    files: {
      'user.ts': 'export class User {}',
      'admin.ts': 'export class Admin {}',
      'public.ts': lines(
        "import { User } from './user.js';",
        'export const publicRegistry = new Map<string, unknown>();',
        "publicRegistry.set('user', User);",
        "export function showPublic(): unknown { return publicRegistry.get('user'); }",
      ),
      'staff.ts': lines(
        "import { Admin } from './admin.js';",
        'export const staffRegistry = new Map<string, unknown>();',
        "staffRegistry.set('user', Admin);",
        "export function showStaff(): unknown { return staffRegistry.get('user'); }",
      ),
    },
    pairs: ['public.ts:showPublic -> user.ts:User', 'staff.ts:showStaff -> admin.ts:Admin'],
    observations: [],
  },
  {
    name: 'numeric keys in a Map stay apart from their string form',
    files: {
      'errors.ts': 'export class NotFound {}',
      'codes.ts': lines(
        "import { NotFound } from './errors.js';",
        'export const codes = new Map<number, unknown>();',
        'codes.set(404, NotFound);',
        'export function byCode(): unknown { return codes.get(404); }',
        "export function byText(): unknown { return codes.get('404'); }",
      ),
    },
    pairs: ['codes.ts:byCode -> errors.ts:NotFound'],
    observations: [],
    edges: [
      'registers registry:codes.ts:codes#number:404 -> errors.ts:NotFound',
      'resolves codes.ts:byCode -> registry:codes.ts:codes#number:404',
      'resolves codes.ts:byText -> registry:codes.ts:codes#404',
    ],
  },
  {
    name: 'dictionary literal declares its registrations',
    files: {
      'home.ts': 'export class Home {}',
      'routes.ts': lines(
        "import { Home } from './home.js';",
        'export const routes: Record<string, unknown> = { home: Home, 404: Home };',
      ),
    },
    pairs: [],
    observations: [],
    edges: [
      'registers registry:routes.ts:routes#404 -> home.ts:Home',
      'registers registry:routes.ts:routes#home -> home.ts:Home',
    ],
  },
  {
    name: 'a lookup whose key another registry declares is reported, not connected',
    files: {
      'user.ts': 'export class User {}',
      'admin.ts': 'export class Admin {}',
      'first.ts': lines(
        "import { User } from './user.js';",
        'export const firstRegistry = new Map<string, unknown>();',
        "firstRegistry.set('user', User);",
      ),
      'second.ts': lines(
        "import { Admin } from './admin.js';",
        'export const secondRegistry = new Map<string, unknown>();',
        "secondRegistry.set('user', Admin);",
      ),
      'third.ts': lines(
        "import { Admin } from './admin.js';",
        'export const thirdRegistry = new Map<string, unknown>();',
        "thirdRegistry.set('admin', Admin);",
        "export function miss(): unknown { return thirdRegistry.get('user'); }",
      ),
    },
    pairs: [],
    observations: ["ambiguous-registry | thirdRegistry.get('user')"],
  },
  {
    name: 'a dynamic key is reported, with no registration invented',
    files: {
      'user.ts': 'export class User {}',
      'dyn.ts': lines(
        "import { User } from './user.js';",
        'export const dynRegistry = new Map<string, unknown>();',
        'export function add(name: string): void { dynRegistry.set(name, User); }',
      ),
    },
    pairs: [],
    observations: ['dynamic-registry-key | dynRegistry.set(name, User)'],
  },
  {
    name: 'unrelated receivers are not registries',
    files: {
      'plain.ts': lines(
        'export class Store { set(k: string, v: unknown): void {} }',
        'declare const thing: any;',
        "export function run(s: Store): void { s.set('user', 1); }",
        "export function other(): void { thing.get('user'); }",
      ),
    },
    pairs: [],
    observations: [],
    edges: [],
  },
  {
    name: 'a lookup into a registry nobody declares stays silent',
    files: {
      'user.ts': 'export class User {}',
      'known.ts': lines(
        "import { User } from './user.js';",
        'export const knownRegistry = new Map<string, unknown>();',
        "knownRegistry.set('user', User);",
      ),
      'unseen.ts':
        "export function read(m: Map<string, unknown>): unknown { return m.get('user'); }",
    },
    pairs: [],
    observations: [],
  },
  {
    name: 'a private index keyed by runtime values is not a registry',
    files: {
      'graph.ts': lines(
        'export class Graph {',
        '  private readonly files = new Map<string, number>();',
        '  add(path: string, size: number): void { this.files.set(path, size); }',
        '  sizeOf(path: string): number | undefined { return this.files.get(path); }',
        '}',
      ),
    },
    pairs: [],
    observations: [],
  },
  {
    name: 'a set of runtime values is not a registry',
    files: {
      'session.ts': lines(
        'export class Session {',
        '  private readonly seen = new Set<number>();',
        '  mark(n: number): void { this.seen.add(n); }',
        '  has(n: number): boolean { return this.seen.has(n); }',
        '}',
      ),
    },
    pairs: [],
    observations: [],
  },
  {
    name: 'a manifest supplies a registration the code does not show',
    files: {
      'settings.ts': 'export class Settings {}',
      'routes.ts': lines(
        'export const registry = new Map<string, unknown>();',
        "export function open(): unknown { return registry.get('settings'); }",
      ),
    },
    options: {
      manifest: [
        { registry: 'routes.ts:registry', key: 'settings', target: 'settings.ts:Settings' },
      ],
    },
    pairs: ['routes.ts:open -> settings.ts:Settings'],
    observations: [],
    edges: [
      'registers registry:routes.ts:registry#settings -> settings.ts:Settings',
      'resolves routes.ts:open -> registry:routes.ts:registry#settings',
    ],
  },
  {
    name: 'a decorator registers a class under its key',
    files: {
      'register.ts':
        'export function register(key: string) { return (target: unknown): unknown => target; }',
      'user.ts': lines(
        "import { register } from './register.js';",
        "@register('user')",
        'export class User {}',
      ),
      'app.ts': lines(
        "import { User } from './user.js';",
        'export const registry = new Map<string, unknown>();',
        "export function load(): unknown { return registry.get('user'); }",
      ),
    },
    options: { decorators: [{ name: 'register', registry: 'app.ts:registry' }] },
    pairs: ['app.ts:load -> user.ts:User'],
    observations: [],
  },
  {
    name: 'files discovered by name are registered, and looked up by name',
    files: {
      'commands/ping.ts': 'export function ping(): void {}',
      'commands/stop.ts': 'export function stop(): void {}',
      'cli.ts': lines(
        'export const commands = new Map<string, unknown>();',
        "export function runPing(): unknown { return commands.get('ping'); }",
      ),
    },
    options: { discover: [{ glob: 'commands/*.ts', registry: 'cli.ts:commands' }] },
    pairs: ['cli.ts:runPing -> commands/ping.ts'],
    observations: [],
    edges: [
      'registers registry:cli.ts:commands#ping -> commands/ping.ts',
      'registers registry:cli.ts:commands#stop -> commands/stop.ts',
      'resolves cli.ts:runPing -> registry:cli.ts:commands#ping',
    ],
  },
  {
    name: 'known limit: a lookup by element access is not mapped yet',
    files: {
      'user.ts': 'export class User {}',
      'routes.ts': lines(
        "import { User } from './user.js';",
        'export const routes: Record<string, unknown> = { home: User };',
        "export function go(): unknown { return routes['home']; }",
      ),
    },
    pairs: ['routes.ts:go -> user.ts:User'],
    observations: [],
    limit: {
      note: 'element reads such as routes[name] are not lookups yet (deferred to conventions)',
      missingPairs: ['routes.ts:go -> user.ts:User'],
      extraPairs: [],
    },
  },
  {
    name: 'known limit: a lookup through a parameter is not joined to the registry it receives',
    files: {
      'user.ts': 'export class User {}',
      'store.ts': lines(
        "import { User } from './user.js';",
        'export const store = new Map<string, unknown>();',
        "store.set('user', User);",
        "export function fetch(m: Map<string, unknown>): unknown { return m.get('user'); }",
        'export function main(): unknown { return fetch(store); }',
      ),
    },
    pairs: ['store.ts:fetch -> user.ts:User'],
    observations: [],
    limit: {
      note: 'the registry identity of a parameter cannot be matched to the registry passed in',
      missingPairs: ['store.ts:fetch -> user.ts:User'],
      extraPairs: [],
    },
  },
];