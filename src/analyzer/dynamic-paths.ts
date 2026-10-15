import type { DynamicPathMode } from '../config/state-config.js';
import type { StateReference } from './state-roots.js';

/**
 * Where a state reference goes once `state.dynamicPaths` is applied: recorded as an edge, or
 * reported as an unresolved `dynamic-state-path`. Every collector returns raw references, with a
 * `null` segment for a computed key, and the emitter calls this, so member access and state method
 * calls treat a computed key the same way.
 */
export type DynamicPathDecision =
  | { readonly kind: 'edge'; readonly reference: StateReference }
  | { readonly kind: 'unresolved'; readonly reference: StateReference; readonly reason: string };

/**
 * `off` reports a reference with a computed key as unresolved and records no edge. `wildcard`
 * records it as an edge whose `null` segment is shown as `[*]`.
 */
export function applyDynamicPaths(
  reference: StateReference,
  mode: DynamicPathMode,
): DynamicPathDecision {
  const reason =
    reference.dynamicReason ??
    (reference.segments.includes(null) ? 'computed property' : undefined);
  if (reason === undefined || mode === 'wildcard') return { kind: 'edge', reference };
  return { kind: 'unresolved', reference, reason };
}
