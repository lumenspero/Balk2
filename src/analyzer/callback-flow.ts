import type { ConnectionGraph } from '../graph.js';
import { runCallbackEngine, type CallbackCatalogEntry } from '../facts/callback-engine.js';
import { applyCallbackEdges } from './callback-apply.js';
import type { CallbackProtocol } from './callback-protocols.js';
import { extractCallbackFacts } from './callback-facts.js';
import type { RepositoryProgram } from './repository-program.js';

/**
 * Callback flow: a configured function receives a callback, so the caller `passesCallback` the
 * callback.
 *
 * - A named callback (`onReady(ready)`) that is a top-level symbol links to it, with `ts-program`
 *   evidence.
 * - An inline callback (`onReady(() => {})`) has no symbol, so the edge targets the enclosing
 *   symbol and carries `metadata.inline`. This makes the edge a self-loop, which is intended.
 * - Any other callback that is not from an external module (a parameter, a local, a call such as
 *   `makeHandler()`) is an `unresolved-callback` observation, linked from the caller at low
 *   confidence. No edge names a target.
 *
 * The TypeScript front end classifies each callback (`callback-facts.ts`), the callback engine
 * decides the edges (`facts/callback-engine.ts`), and `callback-apply.ts` writes them.
 * Callbacks are kept apart from calls: a callback is passed, not invoked, so no `calls` edge is
 * drawn for it.
 */
export function collectCallbackRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  callbacks: readonly CallbackProtocol[],
): void {
  if (callbacks.length === 0) return;

  const catalog = callbacks.map((protocol): CallbackCatalogEntry => ({
    ...protocol,
    languages: ['javascript', 'typescript'],
  }));
  const edges = runCallbackEngine({
    files: extractCallbackFacts(repository, graph, callbacks),
    catalog,
  });
  applyCallbackEdges(graph, edges);
}
