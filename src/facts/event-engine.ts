import type {
  Confidence,
  Evidence,
  EventRelationship,
  RelationshipMetadata,
  SourceSpan,
  UnresolvedReason,
} from '../types.js';
import type { EventCallFact, EventDirectionFact } from './types.js';

/**
 * The event engine (Phase 2.7, events). It reads event-call facts and returns edge descriptions;
 * it never touches the graph.
 *
 * A channel is named by its event and scoped by its receiver's identity, so unrelated emitters
 * that reuse a name stay apart. A receiver that does not qualify as an emitter by type can still
 * qualify heuristically: a receiver used both to subscribe and to publish is an emitter, even when
 * its type says nothing. Whatever cannot be resolved without guessing becomes an observation.
 */

/** One event edge to write, in the order the engine found it. */
export type EventEdge =
  | {
      readonly kind: 'observe';
      readonly relationship: EventRelationship;
      readonly from: string;
      readonly reason: UnresolvedReason;
      readonly subject: string;
      readonly detail: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: 'channel';
      readonly name: string;
      readonly scope: string;
      readonly relationship: EventRelationship;
      readonly from: string;
      readonly confidence: Confidence;
      readonly evidence: Evidence;
      readonly span: SourceSpan;
      readonly metadata?: RelationshipMetadata;
    };

/** Runs the event engine over the event-call facts, in source order. */
export function runEventEngine(input: { readonly facts: readonly EventCallFact[] }): EventEdge[] {
  // Usage evidence counts every call, claimed or not, so it is computed before any is skipped.
  const usage = emitterUsage(input.facts);
  const edges: EventEdge[] = [];

  for (const call of input.facts) {
    const name = call.name;
    if (call.claimed || name.kind === 'not-a-name') continue;
    const identity = call.receiver.identity;

    const observe = (reason: UnresolvedReason, detail: string): void => {
      edges.push({
        kind: 'observe',
        relationship: call.relationship,
        from: call.owner,
        reason,
        subject: call.subject,
        detail,
        span: call.span,
      });
    };

    let qualified = call.receiver.qualifies;
    let heuristic = false;
    if (
      !qualified &&
      call.eventLikeReceiver &&
      identity.kind === 'resolved' &&
      usedAsEmitter(usage, identity.scope)
    ) {
      qualified = true;
      heuristic = true;
    }

    if (!qualified) {
      // An unmatched names or types rule is a deliberate exclusion; only an unrecognized receiver
      // of a generic method name is worth a note.
      if (call.eventLikeReceiver && name.kind === 'static') {
        observe(
          'unknown-event-receiver',
          call.receiver.reason ?? 'receiver is not recognized as an event emitter',
        );
      }
      continue;
    }

    if (name.kind === 'dynamic') {
      observe('dynamic-event-name', name.reason);
      continue;
    }
    if (identity.kind === 'unknown') {
      observe('unknown-event-receiver', identity.reason);
      continue;
    }

    const metadata = metadataOf(call);
    let from = call.owner;
    if (call.direction === 'subscribe' || call.direction === 'unsubscribe') {
      const listener = call.listener;
      if (listener && call.direction === 'subscribe') {
        from = listener;
        if (listener !== call.owner) metadata['registeredBy'] = call.owner;
      } else if (listener) {
        metadata['listener'] = listener;
      }
      Object.assign(metadata, call.options ?? {});
    }

    edges.push({
      kind: 'channel',
      name: name.name,
      scope: identity.scope,
      relationship: call.relationship,
      from,
      confidence: heuristic || identity.confidence !== 'high' ? 'medium' : 'high',
      evidence: evidenceOf(heuristic, call),
      span: call.span,
      ...(Object.keys(metadata).length > 0 ? { metadata: metadata as RelationshipMetadata } : {}),
    });
  }

  return edges;
}

/** The directions each receiver scope is used in, from every call with a resolved receiver. */
function emitterUsage(facts: readonly EventCallFact[]): Map<string, Set<EventDirectionFact>> {
  const directions = new Map<string, Set<EventDirectionFact>>();
  for (const call of facts) {
    const identity = call.receiver.identity;
    if (identity.kind !== 'resolved') continue;
    const seen = directions.get(identity.scope) ?? new Set<EventDirectionFact>();
    seen.add(call.direction);
    directions.set(identity.scope, seen);
  }
  return directions;
}

/** A receiver used both to listen and to publish is an emitter. */
function usedAsEmitter(
  usage: ReadonlyMap<string, ReadonlySet<EventDirectionFact>>,
  scope: string,
): boolean {
  const seen = usage.get(scope);
  return seen !== undefined && seen.has('subscribe') && (seen.has('emit') || seen.has('dispatch'));
}

/** Metadata that is known before the listener is considered: whether the listener runs once. */
function metadataOf(call: EventCallFact): Record<string, string | number | boolean> {
  const metadata: Record<string, string | number | boolean> = {};
  if (call.once) metadata['once'] = true;
  return metadata;
}

/** `heuristic` when usage evidence was needed, else `config` for configured rules, else the compiler. */
function evidenceOf(heuristic: boolean, call: EventCallFact): Evidence {
  if (heuristic) return 'heuristic';
  if (call.protocolSource === 'config' || call.receiver.qualificationEvidence === 'config') {
    return 'config';
  }
  return call.evidence ?? 'ts-program';
}
