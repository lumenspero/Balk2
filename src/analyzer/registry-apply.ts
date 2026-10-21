import type { ConnectionGraph } from '../graph.js';
import type { RegistryEdge } from '../facts/registry-engine.js';

/** Writes registry edges to the graph, in the order the engine found them. */
export function applyRegistryEdges(graph: ConnectionGraph, edges: readonly RegistryEdge[]): void {
  for (const edge of edges) {
    switch (edge.kind) {
      case 'declare': {
        const node = graph.addRegistryKey(edge.key, edge.registry, edge.keyType);
        if (edge.target !== undefined) {
          graph.addRelationship('registers', node.id, edge.target, edge.confidence, {
            evidence: edge.evidence,
          });
        }
        break;
      }
      case 'inject': {
        const node = graph.addRegistryKey(edge.key, edge.registry, edge.keyType);
        graph.addRelationship('resolves', edge.owner, node.id, 'high', {
          evidence: 'config',
          spans: [edge.span],
          metadata: { injection: 'constructor' },
        });
        break;
      }
      case 'use': {
        const node = graph.addRegistryKey(edge.key, edge.registry, edge.keyType);
        if (edge.relationship === 'registers') {
          if (edge.target !== undefined) {
            graph.addRelationship('registers', node.id, edge.target, edge.confidence, {
              evidence: edge.evidence,
              spans: [edge.span],
            });
          }
        } else {
          graph.addRelationship(edge.relationship, edge.from, node.id, edge.confidence, {
            evidence: edge.evidence,
            spans: [edge.span],
          });
        }
        break;
      }
      case 'observe': {
        const unresolved = graph.addUnresolved({
          reason: edge.reason,
          attempted: edge.relationship,
          subject: edge.subject,
          location: edge.span,
          detail: edge.detail,
          ...(edge.tier ? { tier: edge.tier } : {}),
        });
        graph.addRelationship(edge.relationship, edge.from, unresolved.id, 'low', {
          evidence: 'ts-program',
          spans: [edge.span],
        });
        break;
      }
      case 'ambiguous': {
        const unresolved = graph.addUnresolved({
          reason: 'ambiguous-registry',
          attempted: edge.relationship,
          subject: edge.subject,
          location: edge.span,
          candidates: edge.candidates,
          detail: edge.detail,
        });
        graph.addRelationship(edge.relationship, edge.from, unresolved.id, 'low', {
          evidence: 'ts-program',
          spans: [edge.span],
        });
        break;
      }
    }
  }
}
