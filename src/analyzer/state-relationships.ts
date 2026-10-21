import type * as ts from 'typescript';
import type { ConfigProblem } from '../config/config-problem.js';
import type { StateConfig } from '../config/state-config.js';
import type { ConnectionGraph } from '../graph.js';
import { runStateEngine, type StateDynamicPathMode } from '../facts/state-engine.js';
import type { FileFacts, StatePathFact } from '../facts/types.js';
import type { GlobalSymbolIndex } from './global-symbols.js';
import { applyStateEdges } from './state-apply.js';
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

/**
 * Write every state access and state method call in the repository into the graph.
 *
 * The TypeScript front end resolves each access and call to a root and path (`state-paths.ts`,
 * `state-calls.ts`, `state-roots.ts`). Those become state-path facts, the state engine decides what
 * each one links to (`facts/state-engine.ts`), and `state-apply.ts` writes the result. Runs before
 * event and registry detection, which skip the calls it claims.
 */
export function collectStateRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  globals: GlobalSymbolIndex,
  config: StateConfig = {},
): StateRelationshipResult {
  const resolver = new StateRootResolver(repository, globals, config);
  const protocols = stateProtocols(config);
  const mode: StateDynamicPathMode = config.dynamicPaths ?? 'off';
  const claimed = new Set<ts.CallExpression>();
  const files = [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const fileFacts: FileFacts[] = [];
  for (const [filePath, sourceFile] of files) {
    if (sourceFile.isDeclarationFile) continue;

    const calls = collectStateCalls(sourceFile, filePath, resolver, protocols);
    for (const node of calls.claimed) claimed.add(node);
    const accesses = collectStateAccesses(sourceFile, filePath, resolver);

    fileFacts.push({
      filePath,
      language: languageOf(filePath),
      facts: [
        ...accesses.map((access) => toFact(filePath, access)),
        ...calls.calls.map((call) => toFact(filePath, call)),
      ],
    });
  }

  applyStateEdges(graph, runStateEngine({ files: fileFacts, dynamicPaths: mode }));
  return { claimed, problems: resolver.problems };
}

function toFact(filePath: string, fact: StateAccessFact | StateCallFact): StatePathFact {
  const { reference } = fact;
  return {
    kind: 'state-path',
    filePath,
    span: fact.span,
    owner: fact.owner,
    relationship: fact.relationship,
    operation: fact.operation,
    ...('method' in fact ? { method: fact.method } : {}),
    rootKind: reference.rootKind,
    root: reference.root,
    segments: reference.segments,
    confidence: reference.confidence,
    evidence: reference.evidence,
    ...(reference.dynamicReason !== undefined ? { dynamicReason: reference.dynamicReason } : {}),
    subject: fact.subject,
  };
}

function languageOf(filePath: string): FileFacts['language'] {
  return /\.(ts|tsx|mts|cts)$/.test(filePath) ? 'typescript' : 'javascript';
}
