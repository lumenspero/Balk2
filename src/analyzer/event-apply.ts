import type { ConnectionGraph } from '../graph.js';
import type { EventEdge } from '../facts/event-engine.js';

/** Writes event edges to the graph, in the order the engine found them. */
export function applyEventEdges(graph: ConnectionGraph, edges: readonly EventEdge[]): void {
  for (const edge of edges) {
    if (edge.kind === 'observe') {
      const unresolved = graph.addUnresolved({
        reason: edge.reason,
        attempted: edge.relationship,
        subject: edge.subject,
        location: edge.span,
        detail: edge.detail,
      });
      graph.addRelationship(edge.relationship, edge.from, unresolved.id, 'low', {
        evidence: 'ts-program',
        spans: [edge.span],
      });
      continue;
    }

    const channel = graph.addEventChannel(edge.name, edge.scope);
    graph.addRelationship(edge.relationship, edge.from, channel.id, edge.confidence, {
      evidence: edge.evidence,
      spans: [edge.span],
      ...(edge.metadata ? { metadata: edge.metadata } : {}),
    });
  }
}
