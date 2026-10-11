import type { EventProtocolOptions } from '../analyzer/event-protocols.js';

/**
 * A realistic mini-repository with the connections a developer would say it contains.
 *
 * The expectations are written from the code's meaning, not from what the tool prints, so the
 * corpus measures the tool instead of echoing it.
 */
export interface EventFixture {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly options?: EventProtocolOptions;
  /**
   * Publisher to subscriber pairs that share an event, as `publisher -> subscriber`. This is
   * what "navigable through the shared channel" means, independent of channel names.
   */
  readonly pairs: readonly string[];
  /** Observations policy says to report, as `reason | subject`. Everything else stays silent. */
  readonly observations: readonly string[];
  /** The exact event edges, as `type from -> to`. Only for fixtures the tool must get exactly right. */
  readonly edges?: readonly string[];
  /** Present only for a known limit: how the tool currently falls short of `pairs`. */
  readonly limit?: {
    readonly note: string;
    readonly missingPairs: readonly string[];
    readonly extraPairs: readonly string[];
  };
}

export const EMITTER_SOURCE = [
  'export class Emitter {',
  '  on(event: string, listener: (...args: unknown[]) => void): void {}',
  '  once(event: string, listener: (...args: unknown[]) => void): void {}',
  '  off(event: string, listener: (...args: unknown[]) => void): void {}',
  '  emit(event: string, payload?: unknown): void {}',
  '}',
  'export const bus = new Emitter();',
].join('\n');

const lines = (...rows: string[]): string => rows.join('\n');

export const EVENT_CORPUS: readonly EventFixture[] = [
  {
    name: 'typed emitter app: publish, subscribe, unsubscribe and a cascade',
    files: {
      'bus.ts': EMITTER_SOURCE,
      'net.ts': lines(
        "import { bus } from './bus.js';",
        "export function connect(): void { bus.emit('ready', 1); }",
        "export function disconnect(): void { bus.emit('closed'); }",
      ),
      'ui.ts': lines(
        "import { bus } from './bus.js';",
        "export function onReady(): void { bus.emit('loaded'); }",
        'export function onClosed(): void {}',
        "export function init(): void { bus.on('ready', onReady); bus.on('closed', onClosed); }",
        "export function cleanup(): void { bus.off('ready', onReady); }",
      ),
      'log.ts': lines(
        "import { bus } from './bus.js';",
        "export function logReady(): void { bus.once('ready', () => {}); }",
      ),
      'view.ts': lines(
        "import { bus } from './bus.js';",
        'export function render(): void {}',
        "export function mount(): void { bus.on('loaded', render); }",
      ),
    },
    pairs: [
      'net.ts:connect -> ui.ts:onReady',
      'net.ts:connect -> log.ts:logReady',
      'net.ts:disconnect -> ui.ts:onClosed',
      'ui.ts:onReady -> view.ts:render',
    ],
    observations: [],
    edges: [
      'emits net.ts:connect -> event:bus.ts:bus#ready',
      'emits net.ts:disconnect -> event:bus.ts:bus#closed',
      'emits ui.ts:onReady -> event:bus.ts:bus#loaded',
      'subscribes ui.ts:onReady -> event:bus.ts:bus#ready',
      'subscribes ui.ts:onClosed -> event:bus.ts:bus#closed',
      'subscribes log.ts:logReady -> event:bus.ts:bus#ready',
      'subscribes view.ts:render -> event:bus.ts:bus#loaded',
      'unsubscribes ui.ts:cleanup -> event:bus.ts:bus#ready',
    ],
  },
  {
    name: 'DOM: elements, document and window are separate targets',
    files: {
      'page.ts': lines(
        'declare const button: HTMLElement;',
        'declare const panel: HTMLElement;',
        'function onClick(): void {}',
        'function onPanel(): void {}',
        'function onKey(): void {}',
        'function onResize(): void {}',
        'export function wire(): void {',
        "  button.addEventListener('click', onClick);",
        "  panel.addEventListener('click', onPanel);",
        "  document.addEventListener('keydown', onKey, { capture: true });",
        "  window.addEventListener('resize', onResize);",
        '}',
        "export function press(): void { button.dispatchEvent(new Event('click')); }",
        "export function typeKey(): void { document.dispatchEvent(new KeyboardEvent('keydown')); }",
        "export function resize(): void { window.dispatchEvent(new CustomEvent('resize')); }",
        "export function unwire(): void { button.removeEventListener('click', onClick); }",
      ),
    },
    pairs: [
      'page.ts:press -> page.ts:onClick',
      'page.ts:typeKey -> page.ts:onKey',
      'page.ts:resize -> page.ts:onResize',
    ],
    observations: [],
    edges: [
      'subscribes page.ts:onClick -> event:page.ts:button#click',
      'subscribes page.ts:onPanel -> event:page.ts:panel#click',
      'subscribes page.ts:onKey -> event:global:document#keydown',
      'subscribes page.ts:onResize -> event:global:window#resize',
      'dispatches page.ts:press -> event:page.ts:button#click',
      'dispatches page.ts:typeKey -> event:global:document#keydown',
      'dispatches page.ts:resize -> event:global:window#resize',
      'unsubscribes page.ts:unwire -> event:page.ts:button#click',
    ],
  },
  {
    name: 'composition: an emitter held as a class property, reached through this and an instance',
    files: {
      'bus.ts': EMITTER_SOURCE,
      'service.ts': lines(
        "import { Emitter } from './bus.js';",
        'export class Service {',
        '  events = new Emitter();',
        "  start(): void { this.events.emit('started'); }",
        '  onTick(): void {}',
        "  constructor() { this.events.on('tick', this.onTick); }",
        '}',
      ),
      'app.ts': lines(
        "import { Service } from './service.js';",
        'const svc = new Service();',
        'function onStarted(): void {}',
        "export function main(): void { svc.events.on('started', onStarted); svc.events.emit('tick'); }",
      ),
    },
    pairs: [
      'service.ts:Service.start -> app.ts:onStarted',
      'app.ts:main -> service.ts:Service.onTick',
    ],
    observations: [],
    edges: [
      'emits service.ts:Service.start -> event:service.ts:Service.events#started',
      'subscribes app.ts:onStarted -> event:service.ts:Service.events#started',
      'emits app.ts:main -> event:service.ts:Service.events#tick',
      'subscribes service.ts:Service.onTick -> event:service.ts:Service.events#tick',
    ],
  },
  {
    name: 'untyped JavaScript: a receiver used both ways is an emitter, one that only listens is not',
    files: {
      'hub.js': lines(
        'function makeBus() { return {}; }',
        'const bus = makeBus();',
        'const lonely = makeBus();',
        'function onTick() {}',
        'function onTock() {}',
        "function start() { bus.on('tick', onTick); bus.on('tock', onTock); }",
        "function stop() { bus.emit('tick'); }",
        "function watch() { lonely.on('only-listens', onTick); }",
      ),
    },
    pairs: ['hub.js:stop -> hub.js:onTick'],
    observations: ["unknown-event-receiver | lonely.on('only-listens', …)"],
    edges: [
      'emits hub.js:stop -> event:hub.js:bus#tick',
      'subscribes hub.js:onTick -> event:hub.js:bus#tick',
      'subscribes hub.js:onTock -> event:hub.js:bus#tock',
    ],
  },
  {
    name: 'event names from constants, enums, templates and concatenation',
    files: {
      'bus.ts': EMITTER_SOURCE,
      'events.ts': lines(
        "export const READY = 'ready';",
        "export const EVENTS = { LOADED: 'loaded', USER: { LOGIN: 'user:login' } } as const;",
        "export enum Topic { Closed = 'closed' }",
      ),
      'app.ts': lines(
        "import { bus } from './bus.js';",
        "import { READY, EVENTS, Topic } from './events.js';",
        "const PREFIX = 'user';",
        'function onReady(): void {}',
        'function onLoaded(): void {}',
        'function onLogin(): void {}',
        'function onClosed(): void {}',
        'function onLogout(): void {}',
        'export function wire(): void {',
        '  bus.on(READY, onReady);',
        '  bus.on(EVENTS.LOADED, onLoaded);',
        '  bus.on(EVENTS.USER.LOGIN, onLogin);',
        '  bus.on(Topic.Closed, onClosed);',
        '  bus.on(`${PREFIX}:logout`, onLogout);',
        '}',
        'export function fire(name: string): void {',
        "  bus.emit('ready');",
        '  bus.emit(EVENTS.LOADED);',
        "  bus.emit(PREFIX + ':login');",
        "  bus.emit('clo' + 'sed');",
        '  bus.emit(`${PREFIX}:logout`);',
        '  bus.emit(name);',
        '}',
      ),
    },
    pairs: [
      'app.ts:fire -> app.ts:onReady',
      'app.ts:fire -> app.ts:onLoaded',
      'app.ts:fire -> app.ts:onLogin',
      'app.ts:fire -> app.ts:onClosed',
      'app.ts:fire -> app.ts:onLogout',
    ],
    observations: ['dynamic-event-name | bus.emit(name)'],
    edges: [
      'emits app.ts:fire -> event:bus.ts:bus#ready',
      'emits app.ts:fire -> event:bus.ts:bus#loaded',
      'emits app.ts:fire -> event:bus.ts:bus#user:login',
      'emits app.ts:fire -> event:bus.ts:bus#closed',
      'emits app.ts:fire -> event:bus.ts:bus#user:logout',
      'subscribes app.ts:onReady -> event:bus.ts:bus#ready',
      'subscribes app.ts:onLoaded -> event:bus.ts:bus#loaded',
      'subscribes app.ts:onLogin -> event:bus.ts:bus#user:login',
      'subscribes app.ts:onClosed -> event:bus.ts:bus#closed',
      'subscribes app.ts:onLogout -> event:bus.ts:bus#user:logout',
    ],
  },
  {
    name: 'independent systems that all use the event name "ready"',
    files: {
      'bus.ts': EMITTER_SOURCE,
      'systems.ts': lines(
        "import { Emitter } from './bus.js';",
        'const socket = new Emitter();',
        'const store = new Emitter();',
        'const worker = new Emitter();',
        'function onSocket(): void {}',
        'function onStore(): void {}',
        'function onWorker(): void {}',
        'function onDom(): void {}',
        'function onWin(): void {}',
        'export function wire(): void {',
        "  socket.on('ready', onSocket);",
        "  store.on('ready', onStore);",
        "  worker.on('ready', onWorker);",
        "  document.addEventListener('ready', onDom);",
        "  window.addEventListener('ready', onWin);",
        '}',
        "export function fireSocket(): void { socket.emit('ready'); }",
        "export function fireWorker(): void { worker.emit('ready'); }",
        "export function fireDom(): void { document.dispatchEvent(new Event('ready')); }",
      ),
    },
    pairs: [
      'systems.ts:fireSocket -> systems.ts:onSocket',
      'systems.ts:fireWorker -> systems.ts:onWorker',
      'systems.ts:fireDom -> systems.ts:onDom',
    ],
    observations: [],
    edges: [
      'subscribes systems.ts:onSocket -> event:systems.ts:socket#ready',
      'subscribes systems.ts:onStore -> event:systems.ts:store#ready',
      'subscribes systems.ts:onWorker -> event:systems.ts:worker#ready',
      'subscribes systems.ts:onDom -> event:global:document#ready',
      'subscribes systems.ts:onWin -> event:global:window#ready',
      'emits systems.ts:fireSocket -> event:systems.ts:socket#ready',
      'emits systems.ts:fireWorker -> event:systems.ts:worker#ready',
      'dispatches systems.ts:fireDom -> event:global:document#ready',
    ],
  },
  {
    name: 'look-alikes: jQuery-style, Redux-style and other objects that merely share a method name',
    files: {
      'lookalikes.ts': lines(
        'declare const $el: { on(e: string, f: () => void): void; off(e: string): void; trigger(e: string): void };',
        'declare const store: { dispatch(action: unknown): void; subscribe(f: () => void): void };',
        'declare const input: { once(e: string, f: () => void): void };',
        'declare const dynamicEvent: string;',
        'declare const untyped: any;',
        'function h(): void {}',
        "export function jquery(): void { $el.on('click', h); $el.off('click'); $el.trigger('click'); }",
        "export function redux(): void { store.dispatch({ type: 'inc' }); store.subscribe(h); }",
        "export function other(): void { input.once('data', h); }",
        'export function wild(): void { untyped.emit(dynamicEvent); untyped.emit({ a: 1 }); }',
      ),
    },
    pairs: [],
    observations: [
      "unknown-event-receiver | $el.on('click', …)",
      "unknown-event-receiver | $el.off('click')",
      "unknown-event-receiver | input.once('data', …)",
    ],
    edges: [],
  },
  {
    name: 'configured protocols: custom methods, a receiver rule, and a disabled built-in',
    files: {
      'bus.ts': EMITTER_SOURCE,
      'hub.ts': lines(
        'export class PubSub {',
        '  publish(event: string, payload?: unknown): void {}',
        '  listen(event: string, listener: () => void): void {}',
        '}',
        'export const hub = new PubSub();',
        'export const audit = new PubSub();',
      ),
      'use.ts': lines(
        "import { hub, audit } from './hub.js';",
        "import { bus } from './bus.js';",
        'function onX(): void {}',
        'function onAudit(): void {}',
        'export function wire(): void {',
        "  hub.listen('x', onX);",
        "  audit.listen('x', onAudit);",
        "  bus.on('legacy', onX);",
        '}',
        'export function fire(): void {',
        "  hub.publish('x');",
        "  audit.publish('x');",
        "  bus.emit('legacy');",
        '}',
      ),
    },
    options: {
      disable: ['emit'],
      methods: [
        { method: 'publish', direction: 'emit', eventArg: 0, receiver: { names: ['hub'] } },
        {
          method: 'listen',
          direction: 'subscribe',
          eventArg: 0,
          listenerArg: 1,
          receiver: { names: ['hub'] },
        },
      ],
    },
    pairs: ['use.ts:fire -> use.ts:onX'],
    observations: [],
    edges: [
      'emits use.ts:fire -> event:hub.ts:hub#x',
      'subscribes use.ts:onX -> event:hub.ts:hub#x',
      'subscribes use.ts:onX -> event:bus.ts:bus#legacy',
    ],
  },
  {
    name: 'listener attribution: named, method, bind, function-valued, inline and parameter',
    files: {
      'bus.ts': EMITTER_SOURCE,
      'listeners.ts': lines(
        "import { bus } from './bus.js';",
        'function named(): void {}',
        'const arrow = (): void => {};',
        'class Handlers {',
        '  method(): void {}',
        '  wire(): void {',
        "    bus.on('a', this.method);",
        "    bus.on('b', this.method.bind(this));",
        "    bus.on('d', () => {});",
        '  }',
        '}',
        'export function wire(listener: () => void): void {',
        "  bus.on('e', named);",
        "  bus.on('f', arrow);",
        "  bus.on('g', listener);",
        '}',
        'export function fire(): void {',
        "  bus.emit('a'); bus.emit('b'); bus.emit('d'); bus.emit('e'); bus.emit('f'); bus.emit('g');",
        '}',
      ),
    },
    pairs: [
      'listeners.ts:fire -> listeners.ts:Handlers.method',
      'listeners.ts:fire -> listeners.ts:Handlers.wire',
      'listeners.ts:fire -> listeners.ts:named',
      'listeners.ts:fire -> listeners.ts:arrow',
      'listeners.ts:fire -> listeners.ts:wire',
    ],
    observations: [],
    edges: [
      'emits listeners.ts:fire -> event:bus.ts:bus#a',
      'emits listeners.ts:fire -> event:bus.ts:bus#b',
      'emits listeners.ts:fire -> event:bus.ts:bus#d',
      'emits listeners.ts:fire -> event:bus.ts:bus#e',
      'emits listeners.ts:fire -> event:bus.ts:bus#f',
      'emits listeners.ts:fire -> event:bus.ts:bus#g',
      'subscribes listeners.ts:Handlers.method -> event:bus.ts:bus#a',
      'subscribes listeners.ts:Handlers.method -> event:bus.ts:bus#b',
      'subscribes listeners.ts:Handlers.wire -> event:bus.ts:bus#d',
      'subscribes listeners.ts:named -> event:bus.ts:bus#e',
      'subscribes listeners.ts:arrow -> event:bus.ts:bus#f',
      'subscribes listeners.ts:wire -> event:bus.ts:bus#g',
    ],
  },
  {
    name: 'listener options: once, capture, passive and abort signals',
    files: {
      'lifecycle.ts': lines(
        'declare const controller: AbortController;',
        'function onClick(): void {}',
        'function onScroll(): void {}',
        'export function wire(): void {',
        "  document.addEventListener('click', onClick, { once: true, capture: true });",
        "  window.addEventListener('scroll', onScroll, { passive: true, signal: controller.signal });",
        '}',
        "export function teardown(): void { document.removeEventListener('click', onClick, true); }",
        'export function click(): void {',
        "  document.dispatchEvent(new Event('click'));",
        "  window.dispatchEvent(new Event('scroll'));",
        '}',
      ),
    },
    pairs: [
      'lifecycle.ts:click -> lifecycle.ts:onClick',
      'lifecycle.ts:click -> lifecycle.ts:onScroll',
    ],
    observations: [],
    edges: [
      'subscribes lifecycle.ts:onClick -> event:global:document#click',
      'subscribes lifecycle.ts:onScroll -> event:global:window#scroll',
      'unsubscribes lifecycle.ts:teardown -> event:global:document#click',
      'dispatches lifecycle.ts:click -> event:global:document#click',
      'dispatches lifecycle.ts:click -> event:global:window#scroll',
    ],
  },
  {
    name: 'calls that cannot be resolved are reported, not guessed',
    files: {
      'bus.ts': EMITTER_SOURCE,
      'unknown.ts': lines(
        "import { bus } from './bus.js';",
        'declare function getBus(): typeof bus;',
        'declare const name: string;',
        'export function a(): void { bus.emit(name); }',
        "export function b(): void { getBus().emit('x'); }",
        "export function c(): void { document.querySelector('#x')!.addEventListener('click', () => {}); }",
      ),
    },
    pairs: [],
    observations: [
      'dynamic-event-name | bus.emit(name)',
      "unknown-event-receiver | getBus().emit('x')",
      "unknown-event-receiver | document.querySelector('#x')!.addEventListener('click', …)",
    ],
    edges: [],
  },
  {
    name: 'barrels, renames, const aliases and default exports reach the same emitter',
    files: {
      'core/emitter.ts': EMITTER_SOURCE,
      'barrel.ts': "export { bus as appBus } from './core/emitter.js';",
      'shared.ts': "import { Emitter } from './core/emitter.js';\nexport default new Emitter();",
      'a.ts': lines(
        "import { appBus } from './barrel.js';",
        "export function pub(): void { appBus.emit('go'); }",
      ),
      'b.ts': lines(
        "import { bus as renamed } from './core/emitter.js';",
        'const alias = renamed;',
        'function onGo(): void {}',
        "export function sub(): void { alias.on('go', onGo); }",
      ),
      'c.ts': lines(
        "import shared from './shared.js';",
        'function onShared(): void {}',
        "export function s(): void { shared.on('s', onShared); }",
      ),
      'd.ts': lines(
        "import shared from './shared.js';",
        "export function t(): void { shared.emit('s'); }",
      ),
    },
    pairs: ['a.ts:pub -> b.ts:onGo', 'd.ts:t -> c.ts:onShared'],
    observations: [],
    edges: [
      'emits a.ts:pub -> event:core/emitter.ts:bus#go',
      'subscribes b.ts:onGo -> event:core/emitter.ts:bus#go',
      'subscribes c.ts:onShared -> event:shared.ts:default#s',
      'emits d.ts:t -> event:shared.ts:default#s',
    ],
  },

  // ── Known limits: the tool currently falls short of what a developer would say ──────────
  {
    name: 'LIMIT: a class that emits to itself, heard through an instance variable',
    files: {
      'bus.ts': EMITTER_SOURCE,
      'svc.ts': lines(
        "import { Emitter } from './bus.js';",
        "export class Svc extends Emitter { run(): void { this.emit('go'); } }",
        'export const svc = new Svc();',
        'function onGo(): void {}',
        "export function listen(): void { svc.on('go', onGo); }",
      ),
    },
    pairs: ['svc.ts:Svc.run -> svc.ts:onGo'],
    observations: [],
    limit: {
      note: 'this inside the class and the instance variable get different scopes',
      missingPairs: ['svc.ts:Svc.run -> svc.ts:onGo'],
      extraPairs: [],
    },
  },
  {
    name: 'LIMIT: an emitter handed to a function as a parameter',
    files: {
      'bus.ts': EMITTER_SOURCE,
      'wiring.ts': lines(
        "import { Emitter } from './bus.js';",
        'const shared = new Emitter();',
        'function onX(): void {}',
        "function wire(target: Emitter): void { target.on('x', onX); }",
        "export function main(): void { wire(shared); shared.emit('x'); }",
      ),
    },
    pairs: ['wiring.ts:main -> wiring.ts:onX'],
    observations: [],
    limit: {
      note: 'the parameter is a different scope from the variable passed in',
      missingPairs: ['wiring.ts:main -> wiring.ts:onX'],
      extraPairs: [],
    },
  },
  {
    name: 'LIMIT: a shared emitter reached through a factory function',
    files: {
      'bus.ts': EMITTER_SOURCE,
      'factory.ts': lines(
        "import { Emitter } from './bus.js';",
        'const hidden = new Emitter();',
        'function getBus(): Emitter { return hidden; }',
        'function onY(): void {}',
        "export function listen(): void { getBus().on('y', onY); }",
        "export function fire(): void { getBus().emit('y'); }",
      ),
    },
    pairs: ['factory.ts:fire -> factory.ts:onY'],
    observations: [
      "unknown-event-receiver | getBus().on('y', …)",
      "unknown-event-receiver | getBus().emit('y')",
    ],
    limit: {
      note: 'a call result has no identity, so both calls are reported instead of connected',
      missingPairs: ['factory.ts:fire -> factory.ts:onY'],
      extraPairs: [],
    },
  },
];
