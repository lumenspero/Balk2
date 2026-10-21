import type { ConnectionGraph } from '../graph.js';
import type { CallbackEdge } from '../facts/callback-engine.js';

/** Writes callback edges to the graph, in the order they were found. */
export function applyCallbackEdges(graph: ConnectionGraph, edges: readonly CallbackEdge[]): void {
  for (const edge of edges) {
    if (edge.kind === 'passes') {
      graph.addRelationship('passesCallback', edge.from, edge.to, 'high', {
        evidence: edge.evidence,
        spans: [edge.span],
        ...(edge.inline ? { metadata: { inline: true } } : {}),
      });
      continue;
    }
    const unresolved = graph.addUnresolved({
      reason: 'unresolved-callback',
      attempted: 'passesCallback',
      subject: edge.subject,
      location: edge.span,
      detail: edge.detail,
    });
    graph.addRelationship('passesCallback', edge.from, unresolved.id, 'low', {
      evidence: 'ts-program',
      spans: [edge.span],
    });
  }
}
