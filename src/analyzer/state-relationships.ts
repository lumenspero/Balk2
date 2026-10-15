import type * as ts from 'typescript';
import type { ConfigProblem } from '../config/config-problem.js';
import type { DynamicPathMode, StateConfig } from '../config/state-config.js';
import type { ConnectionGraph } from '../graph.js';
import type { RelationshipMetadata } from '../types.js';
import { applyDynamicPaths } from './dynamic-paths.js';
import type { GlobalSymbolIndex } from './global-symbols.js';
import type { RepositoryProgram } from './repository-program.js';
import { collectStateAccesses, type StateAccessFact } from './state-paths.js';
import { collectStateCalls, type StateCallFact, stateProtocols } from './state-calls.js';
import { StateRootResolver } from './state-roots.js';

export interface StateRelationshipResult {
  /**
   * Calls a state method matched. Event and registry detection skip these: a call on shared state
   * is state, not a registry lookup.
   */
  readonly claimed: ReadonlySet<ts.CallExpression>;
  /**
   * Configured singletons that matched no export. They are reported here, not written into the
   * graph, because the graph has no channel for configuration problems.
   */
  readonly problems: readonly ConfigProblem[];
}

type StateFact = StateAccessFact | StateCallFact;

/**
 * Write every state access and state method call in the repository into the graph.
 *
 * A static reference becomes an edge from its owner to a state-path node. A computed key becomes
 * an edge to a wildcard path or an unresolved `dynamic-state-path` observation, as
 * `state.dynamicPaths` says. Runs before event and registry detection, which skip the calls it
 * claims.
 */
export function collectStateRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  globals: GlobalSymbolIndex,
  config: StateConfig = {},
): StateRelationshipResult {
  const resolver = new StateRootResolver(repository, globals, config);
  const protocols = stateProtocols(config);
  const mode: DynamicPathMode = config.dynamicPaths ?? 'off';
  const claimed = new Set<ts.CallExpression>();
  const files = [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  for (const [filePath, sourceFile] of files) {
    if (sourceFile.isDeclarationFile) continue;

    const calls = collectStateCalls(sourceFile, filePath, resolver, protocols);
    for (const node of calls.claimed) claimed.add(node);

    const facts: StateFact[] = [
      ...collectStateAccesses(sourceFile, filePath, resolver),
      ...calls.calls,
    ];
    for (const fact of facts) recordFact(graph, mode, fact);
  }

  return { claimed, problems: resolver.problems };
}

function recordFact(graph: ConnectionGraph, mode: DynamicPathMode, fact: StateFact): void {
  const decision = applyDynamicPaths(fact.reference, mode);

  if (decision.kind === 'unresolved') {
    const unresolved = graph.addUnresolved({
      reason: 'dynamic-state-path',
      attempted: fact.relationship,
      subject: fact.subject,
      location: fact.span,
      detail: decision.reason,
    });
    graph.addRelationship(fact.relationship, fact.owner, unresolved.id, 'low', {
      evidence: 'ts-program',
      spans: [fact.span],
    });
    return;
  }

  const { reference } = decision;
  const target = graph.addStatePath(reference.root, reference.rootKind, reference.segments);
  graph.addRelationship(fact.relationship, fact.owner, target.id, reference.confidence, {
    evidence: reference.evidence,
    spans: [fact.span],
    metadata: metadataOf(fact),
  });
}

function metadataOf(fact: StateFact): RelationshipMetadata {
  return 'method' in fact
    ? { operation: fact.operation, method: fact.method }
    : { operation: fact.operation };
}
