import type { ConnectionGraph } from '../graph.js';
import type { Confidence, RelationshipType } from '../types.js';

/**
 * A project decision about an existing relationship: its confidence is set to `confidence`. An
 * annotation names the relationship by `(type, from, to)`. It never creates one, so a manual fact
 * cannot bypass the detectors.
 */
export interface Annotation {
  readonly type: RelationshipType;
  readonly from: string;
  readonly to: string;
  readonly confidence: Confidence;
}

/** Why an annotation was skipped. The graph is left unchanged for that annotation. */
export interface AnnotationProblem {
  readonly path: string;
  readonly message: string;
}

/**
 * Apply annotations after analysis, so they see the final edges and no later detector can overwrite
 * them. Each annotation is checked before it is applied:
 *
 * - a relationship must already exist with that type, from and to;
 * - a link to an unresolved observation is not changed, since lowering or raising it would hide or
 *   invent a diagnostic.
 *
 * Anything skipped is returned as a problem, so the reader sees it rather than losing it silently.
 */
export function applyAnnotations(
  graph: ConnectionGraph,
  annotations: readonly Annotation[],
): AnnotationProblem[] {
  const problems: AnnotationProblem[] = [];

  annotations.forEach((annotation, index) => {
    const path = `annotations[${index}]`;
    const { type, from, to, confidence } = annotation;

    if (graph.hasUnresolved(to)) {
      problems.push({
        path,
        message: `${type} to ${to} is an unresolved observation; annotation ignored`,
      });
      return;
    }

    const updated = graph.setConfidence(type, from, to, confidence);
    if (!updated) {
      problems.push({
        path,
        message: `no ${type} relationship from ${from} to ${to}; annotation ignored`,
      });
    }
  });

  return problems;
}
