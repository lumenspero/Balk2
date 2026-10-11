import { beforeAll, describe, expect, it, vi } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';
import type { ConnectionMap, Relationship } from '../types.js';
import { JsTsAnalyzer, type RepositoryAnalysisOptions } from './js-ts-analyzer.js';

// Each group builds a TypeScript program; the default 5s limit is tight on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const META = { generatedAt: '2026-01-01T00:00:00Z' };
const EVENT_TYPES = new Set(['emits', 'dispatches', 'subscribes', 'unsubscribes']);

function analyze(
  files: Record<string, string>,
  options?: RepositoryAnalysisOptions,
  compilerOptions?: Record<string, unknown>,
): ConnectionMap {
  const fixture = createRepositoryFixture(files, compilerOptions);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, options);
    return graph.build(META);
  } finally {
    fixture.cleanup();
  }
}

/** Event edges as `type from -> to`, sorted. Edges to unresolved nodes are excluded. */
function edgeLines(map: ConnectionMap): string[] {
  return map.relationships
    .filter((r) => EVENT_TYPES.has(r.type) && !r.to.startsWith('unresolved:'))
    .map((r) => `${r.type} ${r.from} -> ${r.to}`)
    .sort();
}

function edge(map: ConnectionMap, type: string, from: string, to: string): Relationship {
  const found = map.relationships.find((r) => r.type === type && r.from === from && r.to === to);
  if (!found) throw new Error(`No ${type} edge ${from} -> ${to}`);
  return found;
}

const EMITTER = [
  'export class Emitter {',
  '  on(event: string, listener: (...args: unknown[]) => void): void {}',
  '  once(event: string, listener: (...args: unknown[]) => void): void {}',
  '  off(event: string, listener: (...args: unknown[]) => void): void {}',
  '  emit(event: string, payload?: unknown): void {}',
  '}',
  'export const bus = new Emitter();',
].join('\n');

describe('event channels across files', () => {
  let map: ConnectionMap;

  beforeAll(() => {
    map = analyze({
      'bus.ts': EMITTER,
      'net.ts':
        "import { bus } from './bus.js';\nexport function connect(): void { bus.emit('ready', 1); }",
      'ui.ts': [
        "import { bus } from './bus.js';",
        'export function onReady(): void {}',
        "export function init(): void { bus.on('ready', onReady); bus.once('ready', () => {}); }",
        "export function cleanup(): void { bus.off('ready', onReady); }",
        "export function dom(): void { document.addEventListener('click', onReady); document.dispatchEvent(new Event('click')); }",
      ].join('\n'),
    });
  });

  it('creates one channel per event, scoped by the receiver', () => {
    expect(Object.keys(map.eventChannels)).toEqual([
      'event:bus.ts:bus#ready',
      'event:global:document#click',
    ]);
    expect(map.eventChannels['event:bus.ts:bus#ready']).toEqual({
      kind: 'event-channel',
      id: 'event:bus.ts:bus#ready',
      name: 'ready',
      scope: 'bus.ts:bus',
    });
  });

  it('links publishers and listeners to the channel', () => {
    expect(edgeLines(map)).toEqual([
      'dispatches ui.ts:dom -> event:global:document#click',
      'emits net.ts:connect -> event:bus.ts:bus#ready',
      'subscribes ui.ts:init -> event:bus.ts:bus#ready',
      'subscribes ui.ts:onReady -> event:bus.ts:bus#ready',
      'subscribes ui.ts:onReady -> event:global:document#click',
      'unsubscribes ui.ts:cleanup -> event:bus.ts:bus#ready',
    ]);
  });

  it('records evidence, confidence and the call site on each edge', () => {
    const emit = edge(map, 'emits', 'net.ts:connect', 'event:bus.ts:bus#ready');

    expect(emit).toMatchObject({ confidence: 'high', evidence: 'ts-program' });
    expect(emit.spans).toEqual([
      { filePath: 'net.ts', startLine: 2, startColumn: 35, endLine: 2, endColumn: 55 },
    ]);
  });

  it('attributes a named listener to its own symbol and records who registered it', () => {
    const named = edge(map, 'subscribes', 'ui.ts:onReady', 'event:bus.ts:bus#ready');
    expect(named.metadata).toEqual({ registeredBy: 'ui.ts:init' });

    const sameFunction = edge(map, 'subscribes', 'ui.ts:onReady', 'event:global:document#click');
    expect(sameFunction.metadata).toEqual({ registeredBy: 'ui.ts:dom' });
  });

  it('attributes an inline listener to the registering symbol, marking one-time listeners', () => {
    const inline = edge(map, 'subscribes', 'ui.ts:init', 'event:bus.ts:bus#ready');
    expect(inline.metadata).toEqual({ once: true });
  });

  it('attributes an unsubscription to the code that performs it, naming the listener', () => {
    const off = edge(map, 'unsubscribes', 'ui.ts:cleanup', 'event:bus.ts:bus#ready');
    expect(off.metadata).toEqual({ listener: 'ui.ts:onReady' });
  });

  it('reads the name of a dispatched event from the constructed event', () => {
    expect(edge(map, 'dispatches', 'ui.ts:dom', 'event:global:document#click')).toMatchObject({
      confidence: 'high',
    });
  });

  it('adds no unresolved observations for resolvable code', () => {
    expect(map.unresolved).toEqual({});
  });
});

describe('independent event systems that share a name', () => {
  it('keeps each emitter, document and window on its own channel', () => {
    const map = analyze({
      'bus.ts': EMITTER,
      'systems.ts': [
        "import { Emitter } from './bus.js';",
        'const socket = new Emitter();',
        'const other = new Emitter();',
        'function onOther(): void {}',
        'function onDom(): void {}',
        'function onWin(): void {}',
        'export function run(): void {',
        "  socket.emit('ready');",
        "  other.on('ready', onOther);",
        "  document.addEventListener('ready', onDom);",
        "  window.addEventListener('ready', onWin);",
        '}',
      ].join('\n'),
    });

    expect(Object.keys(map.eventChannels)).toEqual([
      'event:global:document#ready',
      'event:global:window#ready',
      'event:systems.ts:other#ready',
      'event:systems.ts:socket#ready',
    ]);
    expect(edgeLines(map)).toEqual([
      'emits systems.ts:run -> event:systems.ts:socket#ready',
      'subscribes systems.ts:onDom -> event:global:document#ready',
      'subscribes systems.ts:onOther -> event:systems.ts:other#ready',
      'subscribes systems.ts:onWin -> event:global:window#ready',
    ]);
  });
});

describe('unresolved observations', () => {
  let map: ConnectionMap;

  beforeAll(() => {
    map = analyze({
      'bus.ts': EMITTER,
      'obs.ts': [
        "import { bus } from './bus.js';",
        'declare function getBus(): typeof bus;',
        'declare const untyped: any;',
        'declare const untypedToo: any;',
        'declare const dynamicName: string;',
        'declare const store: { dispatch(action: unknown): void };',
        'declare const jq: { on(e: string, f: () => void): void };',
        'export function dynamic(): void { bus.emit(dynamicName); }',
        "export function computedReceiver(): void { getBus().emit('x'); }",
        "export function lookalike(): void { jq.on('click', () => {}); }",
        "export function untypedReceiver(): void { untyped.emit('x'); }",
        'export function ignored(): void {',
        "  store.dispatch({ type: 'x' });",
        '  untypedToo.emit(dynamicName);',
        '}',
      ].join('\n'),
    });
  });

  it('reports each case with the reason and a plain explanation', () => {
    expect(
      Object.values(map.unresolved)
        .map((u) => `${u.reason} | ${u.subject} | ${u.detail}`)
        .sort(),
    ).toEqual(
      [
        'dynamic-event-name | bus.emit(dynamicName) | "dynamicName" is not a constant',
        "unknown-event-receiver | getBus().emit('x') | receiver is a computed expression",
        "unknown-event-receiver | jq.on('click', …) | receiver type lacks both a subscribe method and an emit or dispatch method",
        "unknown-event-receiver | untyped.emit('x') | receiver type is not known",
      ].sort(),
    );
  });

  it('links each observation from its owner with a low-confidence edge of the attempted type', () => {
    const unresolvedEdges = map.relationships
      .filter((r) => r.to.startsWith('unresolved:'))
      .map((r) => `${r.type} ${r.from} [${r.confidence}]`)
      .sort();

    expect(unresolvedEdges).toEqual([
      'emits obs.ts:computedReceiver [low]',
      'emits obs.ts:dynamic [low]',
      'emits obs.ts:untypedReceiver [low]',
      'subscribes obs.ts:lookalike [low]',
    ]);
  });

  it('creates no channel or edge for look-alike conventions that are not event calls', () => {
    expect(Object.keys(map.eventChannels)).toEqual([]);
    expect(map.relationships.some((r) => r.from === 'obs.ts:ignored')).toBe(false);
  });

  it('derives a stable observation id from the call site', () => {
    expect(Object.keys(map.unresolved)).toContain('unresolved:dynamic-event-name:obs.ts:8:35');
  });
});

describe('usage evidence in untyped JavaScript', () => {
  let map: ConnectionMap;

  beforeAll(() => {
    map = analyze({
      'app.js': [
        'function makeBus() { return {}; }',
        'const bus = makeBus();',
        'const lonely = makeBus();',
        'function onTick() {}',
        "function start() { bus.on('tick', onTick); }",
        "function stop() { bus.emit('tick'); }",
        "function watch() { lonely.on('only-listens', onTick); }",
      ].join('\n'),
    });
  });

  it('accepts a receiver used both to listen and to publish, at reduced confidence', () => {
    expect(edgeLines(map)).toEqual([
      'emits app.js:stop -> event:app.js:bus#tick',
      'subscribes app.js:onTick -> event:app.js:bus#tick',
    ]);
    expect(edge(map, 'emits', 'app.js:stop', 'event:app.js:bus#tick')).toMatchObject({
      confidence: 'medium',
      evidence: 'heuristic',
    });
  });

  it('keeps a receiver that only listens as an unresolved observation', () => {
    expect(Object.values(map.unresolved).map((u) => u.subject)).toEqual([
      "lonely.on('only-listens', …)",
    ]);
  });
});

describe('configured protocols', () => {
  const FILES = {
    'bus.ts': EMITTER,
    'hub.ts': [
      'export class PubSub {',
      '  publish(event: string): void {}',
      '  listen(event: string, listener: () => void): void {}',
      '}',
      'export const hub = new PubSub();',
      'export const other = new PubSub();',
    ].join('\n'),
    'use.ts': [
      "import { hub, other } from './hub.js';",
      "import { bus } from './bus.js';",
      'export function onX(): void {}',
      'export function run(): void {',
      "  hub.publish('x');",
      "  hub.listen('x', onX);",
      "  other.publish('x');",
      "  bus.emit('y');",
      '}',
    ].join('\n'),
  };
  const METHODS = [
    { method: 'publish', direction: 'emit', eventArg: 0 },
    { method: 'listen', direction: 'subscribe', eventArg: 0, listenerArg: 1 },
  ] as const;

  it('maps project-specific methods, with config evidence', () => {
    const map = analyze(FILES, { events: { methods: METHODS } });

    expect(edgeLines(map)).toEqual([
      'emits use.ts:run -> event:bus.ts:bus#y',
      'emits use.ts:run -> event:hub.ts:hub#x',
      'emits use.ts:run -> event:hub.ts:other#x',
      'subscribes use.ts:onX -> event:hub.ts:hub#x',
    ]);
    expect(edge(map, 'emits', 'use.ts:run', 'event:hub.ts:hub#x').evidence).toBe('config');
    expect(edge(map, 'emits', 'use.ts:run', 'event:bus.ts:bus#y').evidence).toBe('ts-program');
  });

  it('can switch the built-ins off', () => {
    const map = analyze(FILES, { events: { builtIns: false, methods: METHODS } });
    expect(Object.keys(map.eventChannels)).toEqual(['event:hub.ts:hub#x', 'event:hub.ts:other#x']);
  });

  it('can disable a single built-in method without leaving a note', () => {
    const map = analyze(FILES, { events: { disable: ['emit'], methods: METHODS } });

    expect(Object.keys(map.eventChannels)).toEqual(['event:hub.ts:hub#x', 'event:hub.ts:other#x']);
    expect(map.unresolved).toEqual({});
  });

  it('applies a receiver rule silently: unmatched receivers are deliberate exclusions', () => {
    const map = analyze(FILES, {
      events: {
        methods: [
          { method: 'publish', direction: 'emit', eventArg: 0, receiver: { names: ['hub'] } },
        ],
      },
    });

    expect(Object.keys(map.eventChannels)).toEqual(['event:bus.ts:bus#y', 'event:hub.ts:hub#x']);
    expect(map.unresolved).toEqual({});
  });
});

describe('class receivers', () => {
  it('scopes this by class at reduced confidence, and keeps it apart from an instance variable', () => {
    const map = analyze({
      'bus.ts': EMITTER,
      'svc.ts': [
        "import { Emitter } from './bus.js';",
        "export class Svc extends Emitter { run(): void { this.emit('go'); } }",
        'export const svc = new Svc();',
        "export function listen(): void { svc.on('go', () => {}); }",
      ].join('\n'),
    });

    expect(edge(map, 'emits', 'svc.ts:Svc.run', 'event:svc.ts:Svc#go').confidence).toBe('medium');
    expect(edge(map, 'subscribes', 'svc.ts:listen', 'event:svc.ts:svc#go').confidence).toBe('high');
    // Known limit: the class and its instance variable do not share a scope.
    expect(Object.keys(map.eventChannels)).toEqual(['event:svc.ts:Svc#go', 'event:svc.ts:svc#go']);
  });
});

describe('listener owners', () => {
  let map: ConnectionMap;

  beforeAll(() => {
    map = analyze({
      'bus.ts': EMITTER,
      'listeners.ts': [
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
      ].join('\n'),
    });
  });

  it('resolves named functions, function-valued variables and methods, including bind', () => {
    expect(edgeLines(map)).toEqual([
      'subscribes listeners.ts:Handlers.method -> event:bus.ts:bus#a',
      'subscribes listeners.ts:Handlers.method -> event:bus.ts:bus#b',
      'subscribes listeners.ts:Handlers.wire -> event:bus.ts:bus#d',
      'subscribes listeners.ts:arrow -> event:bus.ts:bus#f',
      'subscribes listeners.ts:named -> event:bus.ts:bus#e',
      'subscribes listeners.ts:wire -> event:bus.ts:bus#g',
    ]);
  });

  it('records the registering symbol only when it differs from the listener', () => {
    expect(
      edge(map, 'subscribes', 'listeners.ts:Handlers.method', 'event:bus.ts:bus#a').metadata,
    ).toEqual({ registeredBy: 'listeners.ts:Handlers.wire' });
    expect(edge(map, 'subscribes', 'listeners.ts:named', 'event:bus.ts:bus#e').metadata).toEqual({
      registeredBy: 'listeners.ts:wire',
    });
    expect(
      edge(map, 'subscribes', 'listeners.ts:Handlers.wire', 'event:bus.ts:bus#d').metadata,
    ).toBeUndefined();
  });

  it('falls back to the registering symbol for a listener passed as a parameter', () => {
    expect(
      edge(map, 'subscribes', 'listeners.ts:wire', 'event:bus.ts:bus#g').metadata,
    ).toBeUndefined();
  });
});

describe('merging and determinism', () => {
  const files = {
    'bus.ts': EMITTER,
    'twice.ts': [
      "import { bus } from './bus.js';",
      'export function f(): void {',
      "  bus.emit('e');",
      "  bus.emit('e', 2);",
      '}',
    ].join('\n'),
  };

  it('merges repeated calls into one edge that keeps every call site', () => {
    const map = analyze(files);
    const merged = edge(map, 'emits', 'twice.ts:f', 'event:bus.ts:bus#e');

    expect(map.relationships.filter((r) => r.type === 'emits')).toHaveLength(1);
    expect(merged.spans?.map((span) => span.startLine)).toEqual([3, 4]);
  });

  it('produces identical output on every run', () => {
    expect(JSON.stringify(analyze(files))).toBe(JSON.stringify(analyze(files)));
  });
});

describe('listener options and lifecycle', () => {
  let map: ConnectionMap;

  beforeAll(() => {
    map = analyze({
      'bus.ts': EMITTER,
      'x.ts': [
        "import { bus } from './bus.js';",
        'declare const controller: AbortController;',
        'const ONCE = true;',
        'function onClick(): void {}',
        'function onScroll(): void {}',
        'function onPlain(): void {}',
        'function onShared(): void {}',
        'function onRepeat(): void {}',
        'export function wire(): void {',
        "  document.addEventListener('click', onClick, { once: true, capture: true });",
        "  window.addEventListener('scroll', onScroll, { passive: true, signal: controller.signal });",
        "  document.addEventListener('plain', onPlain);",
        "  bus.once('ready', onShared);",
        '}',
        'export function teardown(): void {',
        "  document.removeEventListener('click', onClick, true);",
        "  document.removeEventListener('plain', onPlain, { once: true, passive: true });",
        '}',
        "export function a(): void { document.addEventListener('k', onShared, { once: ONCE }); }",
        "export function b(): void { document.addEventListener('k', onShared); }",
        'export function c(): void {',
        "  document.addEventListener('r', onRepeat, { once: true });",
        "  document.addEventListener('r', onRepeat, { once: true });",
        '}',
      ].join('\n'),
    });
  });

  it('records the options a listener was registered with', () => {
    expect(edge(map, 'subscribes', 'x.ts:onClick', 'event:global:document#click').metadata).toEqual(
      { registeredBy: 'x.ts:wire', once: true, capture: true },
    );
    expect(edge(map, 'subscribes', 'x.ts:onScroll', 'event:global:window#scroll').metadata).toEqual(
      { registeredBy: 'x.ts:wire', passive: true, abortable: true },
    );
  });

  it('records nothing extra when no option is set', () => {
    expect(edge(map, 'subscribes', 'x.ts:onPlain', 'event:global:document#plain').metadata).toEqual(
      {
        registeredBy: 'x.ts:wire',
      },
    );
  });

  it('keeps once from the method name and the options together', () => {
    expect(edge(map, 'subscribes', 'x.ts:onShared', 'event:bus.ts:bus#ready').metadata).toEqual({
      registeredBy: 'x.ts:wire',
      once: true,
    });
  });

  it('records only capture on an unsubscription, which is what decides what it removes', () => {
    expect(
      edge(map, 'unsubscribes', 'x.ts:teardown', 'event:global:document#click').metadata,
    ).toEqual({ listener: 'x.ts:onClick', capture: true });
    expect(
      edge(map, 'unsubscribes', 'x.ts:teardown', 'event:global:document#plain').metadata,
    ).toEqual({ listener: 'x.ts:onPlain' });
  });

  it('does not claim once for a listener that is also registered without it', () => {
    const merged = edge(map, 'subscribes', 'x.ts:onShared', 'event:global:document#k');

    expect(merged.metadata).toBeUndefined();
    expect(merged.spans).toHaveLength(2);
  });

  it('keeps once when every registration sets it', () => {
    expect(edge(map, 'subscribes', 'x.ts:onRepeat', 'event:global:document#r').metadata).toEqual({
      registeredBy: 'x.ts:c',
      once: true,
    });
  });
});
