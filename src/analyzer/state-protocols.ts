/**
 * State API conventions: method calls on a resolved state root that read, write or delete a
 * path, such as `store.get('user')` or `cache.delete(id)`.
 *
 * A state protocol never decides on its own that a receiver is shared state. It applies only
 * when the receiver already resolves to a state root (a global path, a configured root, or a
 * configured singleton), so a `get` on an unrelated object is never a state access.
 */

/** What a state method does to its path. */
export type StateAccess = 'read' | 'write' | 'delete';

export interface StateProtocol {
  /** Method name, e.g. `get` */
  readonly method: string;
  readonly access: StateAccess;
  /**
   * Argument holding the property key. Without one, the call touches the receiver itself:
   * `store.subscribe(fn)` reads the whole store.
   */
  readonly keyArg?: number;
  /**
   * Splits a key into a path, for APIs that take one string: with `"."`,
   * `store.get('session.user')` touches `session.user`. Only applies with `keyArg`.
   */
  readonly pathSeparator?: string;
}

/**
 * Built-in state methods: Map-like access plus `subscribe`. They are safe as defaults only
 * because they apply to receivers already resolved to a state root.
 */
export const BUILT_IN_STATE_PROTOCOLS: readonly StateProtocol[] = [
  { method: 'get', access: 'read', keyArg: 0 },
  { method: 'has', access: 'read', keyArg: 0 },
  { method: 'subscribe', access: 'read' },
  { method: 'set', access: 'write', keyArg: 0 },
  { method: 'delete', access: 'delete', keyArg: 0 },
];