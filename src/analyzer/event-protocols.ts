import type { EventRelationship } from '../types.js';

/** What a protocol method does to an event channel. */
export type EventDirection = 'subscribe' | 'unsubscribe' | 'emit' | 'dispatch';

/**
 * What the event argument is: the event name itself (`bus.emit('ready')`) or an event object
 * whose constructor carries the name (`target.dispatchEvent(new CustomEvent('ready'))`).
 */
export type EventArgKind = 'name' | 'event-object';

/**
 * Which receivers a protocol applies to.
 *
 * - `any`: the method name alone is distinctive enough.
 * - `event-like`: the receiver's type must look like an event emitter or target, meaning it
 *   declares at least one subscribe method and at least one emit/dispatch method of the active
 *   catalog (so `EventEmitter`, `EventTarget` and `mitt` qualify, while a Redux store or a
 *   jQuery object does not).
 * - an object: the receiver expression's last name is in `names`, or its type's name is in
 *   `types`.
 */
export type ReceiverRule =
  'any' | 'event-like' | { readonly names?: readonly string[]; readonly types?: readonly string[] };

/** One event convention: how a method call maps onto an event channel. */
export interface EventProtocol {
  /** Method name matched on a receiver, e.g. `on` in `bus.on('ready', fn)` */
  readonly method: string;
  readonly direction: EventDirection;
  /** Zero-based index of the event name (or event object) argument */
  readonly eventArg: number;
  /** Defaults to `name` */
  readonly eventArgKind?: EventArgKind;
  /** Zero-based index of the payload argument (`emit` and `dispatch`) */
  readonly payloadArg?: number;
  /** Zero-based index of the listener argument (`subscribe` and `unsubscribe`) */
  readonly listenerArg?: number;
  /** Zero-based index of the listener options argument (`subscribe` and `unsubscribe`) */
  readonly optionsArg?: number;
  /** The listener runs at most once (`subscribe` only) */
  readonly once?: boolean;
  /**
   * Built-in generic names default to `event-like`. A protocol added by configuration defaults
   * to `any`, because naming a method there states the intent to map it.
   */
  readonly receiver?: ReceiverRule;
}

/** Catalog customization, from `protocols.events` in `.balk2.json`. */
export interface EventProtocolOptions {
  /** Use the built-in catalog (default `true`) */
  readonly builtIns?: boolean;
  /**
   * Built-in methods to stop mapping, e.g. when `dispatch` means something else in a project.
   * They still count as evidence that a receiver is an emitter.
   */
  readonly disable?: readonly string[];
  /** Project-specific protocols; one for an existing method name replaces that entry */
  readonly methods?: readonly EventProtocol[];
}

/** A protocol with every default applied, plus where it came from. */
export interface ResolvedEventProtocol {
  readonly method: string;
  readonly direction: EventDirection;
  readonly relationship: EventRelationship;
  readonly eventArg: number;
  readonly eventArgKind: EventArgKind;
  readonly payloadArg?: number;
  readonly listenerArg?: number;
  readonly optionsArg?: number;
  readonly once: boolean;
  readonly receiver: ReceiverRule;
  /** `config` protocols produce relationships with `config` evidence */
  readonly source: 'built-in' | 'config';
}

/**
 * The small, conservative built-in catalog. `addEventListener`, `removeEventListener` and
 * `dispatchEvent` are distinctive; the generic names need evidence about the receiver.
 */
export const BUILT_IN_EVENT_PROTOCOLS: readonly EventProtocol[] = [
  { method: 'on', direction: 'subscribe', eventArg: 0, listenerArg: 1, receiver: 'event-like' },
  {
    method: 'once',
    direction: 'subscribe',
    eventArg: 0,
    listenerArg: 1,
    once: true,
    receiver: 'event-like',
  },
  { method: 'off', direction: 'unsubscribe', eventArg: 0, listenerArg: 1, receiver: 'event-like' },
  { method: 'emit', direction: 'emit', eventArg: 0, payloadArg: 1, receiver: 'event-like' },
  { method: 'dispatch', direction: 'dispatch', eventArg: 0, payloadArg: 1, receiver: 'event-like' },
  {
    method: 'addEventListener',
    direction: 'subscribe',
    eventArg: 0,
    listenerArg: 1,
    optionsArg: 2,
    receiver: 'any',
  },
  {
    method: 'removeEventListener',
    direction: 'unsubscribe',
    eventArg: 0,
    listenerArg: 1,
    optionsArg: 2,
    receiver: 'any',
  },
  {
    method: 'dispatchEvent',
    direction: 'dispatch',
    eventArg: 0,
    eventArgKind: 'event-object',
    receiver: 'any',
  },
];

const RELATIONSHIPS: Readonly<Record<EventDirection, EventRelationship>> = {
  subscribe: 'subscribes',
  unsubscribe: 'unsubscribes',
  emit: 'emits',
  dispatch: 'dispatches',
};

/** The relationship type a direction produces. */
export function relationshipOf(direction: EventDirection): EventRelationship {
  return RELATIONSHIPS[direction];
}

/**
 * The active set of event protocols: the built-ins (unless switched off), minus disabled
 * methods, with configured protocols layered on top. At most one protocol exists per method
 * name; a configured one replaces the built-in of the same name.
 */
export class EventProtocolCatalog {
  private readonly byMethod: ReadonlyMap<string, ResolvedEventProtocol>;
  private readonly evidence: ReadonlyMap<string, ResolvedEventProtocol>;

  constructor(options: EventProtocolOptions = {}) {
    const protocols = new Map<string, ResolvedEventProtocol>();
    const evidence = new Map<string, ResolvedEventProtocol>();

    if (options.builtIns !== false) {
      const disabled = new Set(options.disable ?? []);
      for (const protocol of BUILT_IN_EVENT_PROTOCOLS) {
        const resolved = resolve(protocol, 'built-in');
        // A disabled method is no longer mapped, but it still says what an emitter looks like.
        evidence.set(protocol.method, resolved);
        if (!disabled.has(protocol.method)) protocols.set(protocol.method, resolved);
      }
    }

    for (const protocol of options.methods ?? []) {
      const resolved = resolve(protocol, 'config');
      protocols.set(protocol.method, resolved);
      evidence.set(protocol.method, resolved);
    }

    this.byMethod = protocols;
    this.evidence = evidence;
  }

  /** The protocol for a method name, if any. */
  forMethod(method: string): ResolvedEventProtocol | undefined {
    return this.byMethod.get(method);
  }

  /** Every protocol, sorted by method name. */
  all(): readonly ResolvedEventProtocol[] {
    return [...this.byMethod.values()].sort((a, b) =>
      a.method < b.method ? -1 : a.method > b.method ? 1 : 0,
    );
  }

  /** Sorted method names whose protocol has one of the given directions. */
  methodsFor(...directions: readonly EventDirection[]): readonly string[] {
    return this.all()
      .filter((protocol) => directions.includes(protocol.direction))
      .map((protocol) => protocol.method);
  }

  /**
   * Sorted method names that count as evidence a receiver is an emitter: the built-ins (unless
   * switched off) and the configured methods, whether or not a built-in was disabled. Disabling
   * stops a call being mapped; it does not change what an emitter looks like.
   */
  evidenceMethodsFor(...directions: readonly EventDirection[]): readonly string[] {
    return [...this.evidence.values()]
      .filter((protocol) => directions.includes(protocol.direction))
      .map((protocol) => protocol.method)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

function resolve(protocol: EventProtocol, source: 'built-in' | 'config'): ResolvedEventProtocol {
  return {
    method: protocol.method,
    direction: protocol.direction,
    relationship: relationshipOf(protocol.direction),
    eventArg: protocol.eventArg,
    eventArgKind: protocol.eventArgKind ?? 'name',
    ...(protocol.payloadArg !== undefined ? { payloadArg: protocol.payloadArg } : {}),
    ...(protocol.listenerArg !== undefined ? { listenerArg: protocol.listenerArg } : {}),
    ...(protocol.optionsArg !== undefined ? { optionsArg: protocol.optionsArg } : {}),
    once: protocol.once ?? false,
    receiver: protocol.receiver ?? (source === 'built-in' ? 'event-like' : 'any'),
    source,
  };
}
