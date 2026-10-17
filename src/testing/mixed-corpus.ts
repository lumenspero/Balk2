import { EMITTER_SOURCE } from './event-corpus.js';

/**
 * Repositories where one code path crosses mechanisms: an event hands off to a handler, the
 * handler looks up a registry and touches shared state. Each family is checked on its own, and
 * the exact family edges are checked together, so a link lost at any step shows up here.
 *
 * Expectations are written from the code's meaning, not from what the tool prints.
 */
export interface MixedFixture {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  /** Publisher to subscriber pairs, as `publisher -> subscriber`. */
  readonly events: readonly string[];
  /** Caller to target pairs through a registry key, as `caller -> target`. */
  readonly registries: readonly string[];
  /** Owner to state-path pairs, as `owner -> state:<root>#<path>`. */
  readonly states: readonly string[];
  /** Observations policy says to report, as `reason | subject`. */
  readonly observations: readonly string[];
  /** Every event, registry, state and global edge, as `type from -> to`. */
  readonly edges: readonly string[];
}

const lines = (...rows: string[]): string => rows.join('\n');

export const MIXED_CORPUS: readonly MixedFixture[] = [
  {
    name: 'an event handler looks up a registry and writes shared state, read back elsewhere',
    files: {
      'emitter.ts': EMITTER_SOURCE,
      'order-service.ts': 'export class OrderService { handle(): void {} }',
      'registry.ts': lines(
        "import { OrderService } from './order-service.js';",
        'export const services = new Map<string, unknown>();',
        "services.set('order', OrderService);",
      ),
      'state.js': 'window.appState = { orders: 0 };',
      'publisher.ts': lines(
        "import { bus } from './emitter.js';",
        "export function place(): void { bus.emit('order:placed', {}); }",
      ),
      'subscriber.ts': lines(
        "import { bus } from './emitter.js';",
        "import { services } from './registry.js';",
        'export function wire(): void {',
        "  bus.on('order:placed', () => { services.get('order'); appState.orders = 1; });",
        '}',
        'export function report(): number { return appState.orders; }',
      ),
    },
    events: ['publisher.ts:place -> subscriber.ts:wire'],
    registries: ['subscriber.ts:wire -> order-service.ts:OrderService'],
    states: [
      'state.js -> state:global#appState',
      'subscriber.ts:report -> state:global#appState.orders',
      'subscriber.ts:wire -> state:global#appState.orders',
    ],
    observations: [],
    edges: [
      'emits publisher.ts:place -> event:emitter.ts:bus#order:placed',
      'readsState subscriber.ts:report -> state:global#appState.orders',
      'references subscriber.ts -> state.js',
      'references subscriber.ts:report -> state.js:appState',
      'references subscriber.ts:wire -> state.js:appState',
      'registers registry:registry.ts:services#order -> order-service.ts:OrderService',
      'resolves subscriber.ts:wire -> registry:registry.ts:services#order',
      'subscribes subscriber.ts:wire -> event:emitter.ts:bus#order:placed',
      'writesState state.js -> state:global#appState',
      'writesState subscriber.ts:wire -> state:global#appState.orders',
    ],
  },
  {
    name: 'the same event name on another receiver does not carry the handler across',
    files: {
      'emitter.ts': `${EMITTER_SOURCE}\nexport const other = new Emitter();`,
      'order-service.ts': 'export class OrderService { handle(): void {} }',
      'registry.ts': lines(
        "import { OrderService } from './order-service.js';",
        'export const services = new Map<string, unknown>();',
        "services.set('order', OrderService);",
      ),
      'publisher.ts': lines(
        "import { other } from './emitter.js';",
        "export function place(): void { other.emit('order:placed', {}); }",
      ),
      'subscriber.ts': lines(
        "import { bus } from './emitter.js';",
        "import { services } from './registry.js';",
        'export function wire(): void {',
        "  bus.on('order:placed', () => { services.get('order'); });",
        '}',
      ),
    },
    events: [],
    registries: ['subscriber.ts:wire -> order-service.ts:OrderService'],
    states: [],
    observations: [],
    edges: [
      'emits publisher.ts:place -> event:emitter.ts:other#order:placed',
      'registers registry:registry.ts:services#order -> order-service.ts:OrderService',
      'resolves subscriber.ts:wire -> registry:registry.ts:services#order',
      'subscribes subscriber.ts:wire -> event:emitter.ts:bus#order:placed',
    ],
  },
];
