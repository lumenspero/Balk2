import type { RegistryRelationship } from '../types.js';

/**
 * What a protocol method does to a registry key.
 *
 * - `register`: stores a key, optionally with the target it maps to (`map.set('user', User)`).
 * - `resolve`: looks a key up and gets its target (`container.resolve('user')`).
 * - `route`: navigates to a key (`router.navigate('/users')`).
 */
export type RegistryDirection = 'register' | 'resolve' | 'route';

/**
 * Which receivers a protocol applies to.
 *
 * - `registry-like`: the receiver type is a registry. It is a dictionary (it has an index
 *   signature, and is not an array), or set-like (it has `add` and `has`), or it declares at
 *   least one register method and one lookup method of the active catalog.
 * - `any`: the method name alone is distinctive enough.
 * - an object: the receiver expression's last name is in `names`, or its type's name is in `types`.
 */
export type RegistryRule =
  | 'registry-like'
  | 'any'
  | { readonly names?: readonly string[]; readonly types?: readonly string[] };

/** One registry convention: how a method call maps onto a registry key. */
export interface RegistryProtocol {
  /** Method name matched on a receiver, e.g. `set` in `map.set('user', User)` */
  readonly method: string;
  readonly direction: RegistryDirection;
  /** Zero-based index of the key argument */
  readonly keyArg: number;
  /** Zero-based index of the target argument (`register` only) */
  readonly valueArg?: number;
  /**
   * Built-in methods default to `registry-like`. A protocol added by configuration defaults to
   * `any`, because naming a method there states the intent to map it.
   */
  readonly receiver?: RegistryRule;
}

/** A decorator convention: a call to `name` registers the decorated class or method. */
export interface RegistryDecoratorRule {
  /** The decorator's identifier, as written at the use site */
  readonly name: string;
  /** Explicit registry identity, such as `src/container.ts:container` */
  readonly registry: string;
  /** Zero-based index of the key argument; default 0 */
  readonly keyArg?: number;
}

/** One explicit registration: `key` in `registry` maps to `target`. */
export interface RegistryManifestEntry {
  readonly registry: string;
  readonly key: string;
  /** A symbol id (`src/user.ts:User`) or a file path */
  readonly target: string;
}

/** A file convention: every file matching `glob` registers under its name, in `registry`. */
export interface RegistryDiscoverRule {
  /** Repository-relative glob, such as `src/commands/*.ts` */
  readonly glob: string;
  readonly registry: string;
}

/** Catalog customization, from `protocols.registries` in `.balk2.json`. */
export interface RegistryProtocolOptions {
  /** Use the built-in catalog (default `true`) */
  readonly builtIns?: boolean;
  /**
   * Decorators that register what they decorate: `{ name: 'register', registry, keyArg: 0 }`
   * maps `@register('user') class User` to the key `user` of `registry`.
   */
  readonly decorators?: readonly RegistryDecoratorRule[];
  /** Explicit registrations, such as for generated code that no call site shows */
  readonly manifest?: readonly RegistryManifestEntry[];
  /** Files that register themselves under their name, found by glob */
  readonly discover?: readonly RegistryDiscoverRule[];
  /**
   * Built-in methods to stop mapping. They still count as evidence that a receiver is a
   * registry.
   */
  readonly disable?: readonly string[];
  /** Project-specific protocols; one for an existing method name replaces that entry */
  readonly methods?: readonly RegistryProtocol[];
}

/** A protocol with every default applied, plus where it came from. */
export interface ResolvedRegistryProtocol {
  readonly method: string;
  readonly direction: RegistryDirection;
  readonly relationship: RegistryRelationship;
  readonly keyArg: number;
  readonly valueArg?: number;
  readonly receiver: RegistryRule;
  /** `config` protocols produce relationships with `config` evidence */
  readonly source: 'built-in' | 'config';
}

/**
 * The conservative built-in catalog. Generic names such as `get` and `set` are only mapped on a
 * registry-like receiver; `navigate` is the only route convention built in.
 */
export const BUILT_IN_REGISTRY_PROTOCOLS: readonly RegistryProtocol[] = [
  { method: 'register', direction: 'register', keyArg: 0, valueArg: 1 },
  { method: 'set', direction: 'register', keyArg: 0, valueArg: 1 },
  { method: 'add', direction: 'register', keyArg: 0 },
  { method: 'get', direction: 'resolve', keyArg: 0 },
  { method: 'resolve', direction: 'resolve', keyArg: 0 },
  { method: 'create', direction: 'resolve', keyArg: 0 },
  { method: 'load', direction: 'resolve', keyArg: 0 },
  { method: 'navigate', direction: 'route', keyArg: 0 },
];

const RELATIONSHIPS: Readonly<Record<RegistryDirection, RegistryRelationship>> = {
  register: 'registers',
  resolve: 'resolves',
  route: 'routesTo',
};

/** The relationship type a direction produces. */
export function registryRelationshipOf(direction: RegistryDirection): RegistryRelationship {
  return RELATIONSHIPS[direction];
}

/**
 * The active set of registry protocols: the built-ins (unless switched off), minus disabled
 * methods, with configured protocols layered on top. At most one protocol exists per method name.
 */
export class RegistryProtocolCatalog {
  private readonly byMethod: ReadonlyMap<string, ResolvedRegistryProtocol>;
  private readonly evidence: ReadonlyMap<string, ResolvedRegistryProtocol>;

  constructor(options: RegistryProtocolOptions = {}) {
    const protocols = new Map<string, ResolvedRegistryProtocol>();
    const evidence = new Map<string, ResolvedRegistryProtocol>();

    if (options.builtIns !== false) {
      const disabled = new Set(options.disable ?? []);
      for (const protocol of BUILT_IN_REGISTRY_PROTOCOLS) {
        const resolved = resolveProtocol(protocol, 'built-in');
        // A disabled method is no longer mapped, but it still says what a registry looks like.
        evidence.set(protocol.method, resolved);
        if (!disabled.has(protocol.method)) protocols.set(protocol.method, resolved);
      }
    }

    for (const protocol of options.methods ?? []) {
      const resolved = resolveProtocol(protocol, 'config');
      protocols.set(protocol.method, resolved);
      evidence.set(protocol.method, resolved);
    }

    this.byMethod = protocols;
    this.evidence = evidence;
  }

  /** The protocol for a method name, if any. */
  forMethod(method: string): ResolvedRegistryProtocol | undefined {
    return this.byMethod.get(method);
  }

  /** Every protocol, sorted by method name. */
  all(): readonly ResolvedRegistryProtocol[] {
    return [...this.byMethod.values()].sort((a, b) =>
      a.method < b.method ? -1 : a.method > b.method ? 1 : 0,
    );
  }

  /** Sorted method names whose protocol has one of the given directions. */
  methodsFor(...directions: readonly RegistryDirection[]): readonly string[] {
    return this.all()
      .filter((protocol) => directions.includes(protocol.direction))
      .map((protocol) => protocol.method);
  }

  /**
   * Sorted method names that count as evidence a receiver is a registry: the built-ins (unless
   * switched off) and the configured methods, whether or not a built-in was disabled.
   */
  evidenceMethodsFor(...directions: readonly RegistryDirection[]): readonly string[] {
    return [...this.evidence.values()]
      .filter((protocol) => directions.includes(protocol.direction))
      .map((protocol) => protocol.method)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

function resolveProtocol(
  protocol: RegistryProtocol,
  source: 'built-in' | 'config',
): ResolvedRegistryProtocol {
  return {
    method: protocol.method,
    direction: protocol.direction,
    relationship: registryRelationshipOf(protocol.direction),
    keyArg: protocol.keyArg,
    ...(protocol.valueArg !== undefined ? { valueArg: protocol.valueArg } : {}),
    receiver: protocol.receiver ?? (source === 'built-in' ? 'registry-like' : 'any'),
    source,
  };
}
