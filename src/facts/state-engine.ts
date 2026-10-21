import type {
  Confidence,
  Evidence,
  RelationshipMetadata,
  SourceSpan,
  StatePathSegment,
  StateRelationship,
  StateRootKind,
} from '../types.js';
import type { FileFacts, StatePathFact } from './types.js';

/**
 * The state engine (Phase 2.7, state). It reads state-path facts and returns edge descriptions. A
 * static reference links its owner to a state-path node. A computed key is either a wildcard path
 * or an observation, as `state.dynamicPaths` says.
 */

/** How computed keys are recorded (`state.dynamicPaths`). */
export type StateDynamicPathMode = 'off' | 'wildcard';

/** Detail recorded for a computed key that has no reason of its own. */
export const COMPUTED_PROPERTY_DETAIL = 'computed property';

/** What the engine found, to be applied to the graph. */
export type StateEdge =
  | {
      readonly kind: 'access';
      readonly from: string;
      readonly relationship: StateRelationship;
      readonly root: string;
      readonly rootKind: StateRootKind;
      readonly segments: readonly StatePathSegment[];
      readonly confidence: Confidence;
      readonly evidence: Evidence;
      readonly span: SourceSpan;
      readonly metadata: RelationshipMetadata;
    }
  | {
      readonly kind: 'observation';
      readonly from: string;
      readonly relationship: StateRelationship;
      readonly subject: string;
      readonly detail: string;
      readonly span: SourceSpan;
    };

/** Runs the state engine over every file's facts, in file order. */
export function runStateEngine(input: {
  readonly files: readonly FileFacts[];
  readonly dynamicPaths: StateDynamicPathMode;
}): StateEdge[] {
  const edges: StateEdge[] = [];
  for (const file of input.files) {
    for (const fact of file.facts) {
      if (fact.kind !== 'state-path') continue;
      const from = fact.owner ?? fact.filePath;
      const reason = unresolvedReason(fact, input.dynamicPaths);
      if (reason !== undefined) {
        edges.push({
          kind: 'observation',
          from,
          relationship: fact.relationship,
          subject: fact.subject,
          detail: reason,
          span: fact.span,
        });
        continue;
      }
      edges.push({
        kind: 'access',
        from,
        relationship: fact.relationship,
        root: fact.root,
        rootKind: fact.rootKind,
        segments: fact.segments,
        confidence: fact.confidence,
        evidence: fact.evidence,
        span: fact.span,
        metadata: metadataOf(fact),
      });
    }
  }
  return edges;
}

/** The reason a reference cannot be recorded as a path, or undefined when it can. */
function unresolvedReason(fact: StatePathFact, mode: StateDynamicPathMode): string | undefined {
  const reason =
    fact.dynamicReason ?? (fact.segments.includes(null) ? COMPUTED_PROPERTY_DETAIL : undefined);
  if (reason === undefined || mode === 'wildcard') return undefined;
  return reason;
}

function metadataOf(fact: StatePathFact): RelationshipMetadata {
  return fact.method !== undefined
    ? { operation: fact.operation, method: fact.method }
    : { operation: fact.operation };
}
