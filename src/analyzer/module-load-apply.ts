import type { ConnectionGraph } from '../graph.js';
import { runModuleLoadEngine, type ModuleLoadEdge } from '../facts/module-load-engine.js';
import { moduleLoadFacts } from './module-load-facts.js';
import type { ModuleLoad } from './module-loads.js';

/**
 * Writes module loads to the graph through the module-load engine. Internal loads are applied
 * first, then dynamic-specifier observations, the same order the analyzer has always used.
 *
 * A load whose owner already has an `imports` edge to the same file keeps that edge exactly as it
 * was. A dynamic load is recorded as a low-confidence link to an unresolved node, so the graph never
 * guesses which file the load reaches.
 */
export function applyModuleLoads(loads: readonly ModuleLoad[], graph: ConnectionGraph): void {
  applyModuleLoadEdges(runModuleLoadEngine(moduleLoadFacts(loads)), graph);
}

/** Writes the engine's module-load edges to the graph, in the same order as `applyModuleLoads`. */
export function applyModuleLoadEdges(
  edges: readonly ModuleLoadEdge[],
  graph: ConnectionGraph,
): void {
  for (const edge of edges) {
    if (edge.kind !== 'imports') continue;
    const alreadyLinked = graph
      .getRelationships(edge.from)
      .some((rel) => rel.type === 'imports' && rel.from === edge.from && rel.to === edge.to);
    if (alreadyLinked) continue;
    graph.addRelationship('imports', edge.from, edge.to, 'high', {
      evidence: 'ts-program',
      spans: [edge.span],
      metadata: { loadKind: edge.loadKind },
    });
  }

  for (const edge of edges) {
    if (edge.kind !== 'observation') continue;
    const unresolved = graph.addUnresolved({
      reason: 'dynamic-module-specifier',
      attempted: 'imports',
      subject: edge.subject,
      location: edge.span,
      detail: edge.detail,
    });
    graph.addRelationship('imports', edge.from, unresolved.id, 'low', {
      evidence: 'ts-program',
      spans: [edge.span],
      metadata: { loadKind: edge.loadKind },
    });
  }
}
