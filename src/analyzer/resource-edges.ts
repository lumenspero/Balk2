import type { ConnectionGraph } from '../graph.js';
import type { ResourceEdge } from '../facts/resource-engine.js';

/** Writes resource edges from the resource engine to the graph, in the order they were found. */
export function applyResourceEdges(graph: ConnectionGraph, edges: readonly ResourceEdge[]): void {
  for (const edge of edges) {
    if (edge.kind === 'uses') {
      const node = graph.addResource(edge.resourcePath, edge.resourceKind);
      graph.addRelationship('usesResource', edge.from, node.id, edge.confidence, {
        evidence: edge.evidence,
        spans: [edge.span],
        metadata: { resourceKind: edge.resourceKind, mechanism: edge.mechanism },
      });
      continue;
    }
    const unresolved = graph.addUnresolved({
      reason: 'dynamic-resource-specifier',
      attempted: 'usesResource',
      subject: edge.subject,
      location: edge.span,
      detail: edge.detail,
    });
    graph.addRelationship('usesResource', edge.from, unresolved.id, 'low', {
      evidence: 'ts-program',
      spans: [edge.span],
    });
  }
}
