import type { ConnectionGraph } from '../graph.js';
import type { StateEdge } from '../facts/state-engine.js';

/** Writes state edges to the graph, in the order they were found. */
export function applyStateEdges(graph: ConnectionGraph, edges: readonly StateEdge[]): void {
  for (const edge of edges) {
    if (edge.kind === 'access') {
      const target = graph.addStatePath(edge.root, edge.rootKind, edge.segments);
      graph.addRelationship(edge.relationship, edge.from, target.id, edge.confidence, {
        evidence: edge.evidence,
        spans: [edge.span],
        metadata: edge.metadata,
      });
      continue;
    }
    const unresolved = graph.addUnresolved({
      reason: 'dynamic-state-path',
      attempted: edge.relationship,
      subject: edge.subject,
      location: edge.span,
      detail: edge.detail,
    });
    graph.addRelationship(edge.relationship, edge.from, unresolved.id, 'low', {
      evidence: 'ts-program',
      spans: [edge.span],
    });
  }
}
