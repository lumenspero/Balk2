import type { ConnectionGraph } from '../graph.js';
import type { MetadataEdge } from '../facts/metadata-engine.js';

/** Writes metadata edges to the graph, in the order they were found. */
export function applyMetadataEdges(graph: ConnectionGraph, edges: readonly MetadataEdge[]): void {
  for (const edge of edges) {
    if (edge.kind === 'defines') {
      const keyNode = graph.addMetadataKey(edge.key);
      graph.addRelationship('definesMetadata', edge.target, keyNode.id, 'high', {
        evidence: 'ts-program',
        spans: [edge.span],
      });
      continue;
    }
    if (edge.kind === 'reads') {
      const keyNode = graph.addMetadataKey(edge.key);
      graph.addRelationship('readsMetadata', edge.from, keyNode.id, 'high', {
        evidence: 'ts-program',
        spans: [edge.span],
      });
      continue;
    }
    const unresolved = graph.addUnresolved({
      reason: 'unresolved-metadata-key',
      attempted: edge.attempted,
      subject: edge.subject,
      location: edge.span,
      detail: edge.detail,
    });
    graph.addRelationship(edge.attempted, edge.from, unresolved.id, 'low', {
      evidence: 'ts-program',
      spans: [edge.span],
    });
  }
}
