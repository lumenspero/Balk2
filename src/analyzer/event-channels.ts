import type * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import { runEventEngine } from '../facts/event-engine.js';
import { applyEventEdges } from './event-apply.js';
import { extractEventFacts } from './event-facts.js';
import { EventProtocolCatalog, type EventProtocolOptions } from './event-protocols.js';
import type { RepositoryProgram } from './repository-program.js';

/**
 * Event pass: map protocol calls (`bus.on('ready', fn)`, `bus.emit('ready')`,
 * `target.dispatchEvent(new Event('ready'))`, ...) onto event channels.
 *
 * The front end reads each call (`event-facts.ts`), the engine decides what it links to
 * (`facts/event-engine.ts`), and `event-apply.ts` writes the result in the order it was found.
 *
 * A channel is named by the event and scoped by the identity of the receiver, so unrelated
 * emitters that reuse a name stay separate. Publishers link to the channel with `emits` or
 * `dispatches`, listeners with `subscribes` and `unsubscribes`. Whatever cannot be resolved
 * without guessing (a dynamic name, an unidentifiable receiver, a receiver that does not look
 * like an emitter) becomes an unresolved observation linked by a low-confidence relationship.
 *
 * Runs after the per-file pass, so listener symbols already exist in the graph. Every read happens
 * before any write, which is safe because event writes never change which symbols the graph holds.
 */
export function collectEventRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  options: EventProtocolOptions = {},
  claimed: ReadonlySet<ts.Node> = new Set(),
): void {
  const catalog = new EventProtocolCatalog(options);
  const facts = extractEventFacts(repository, graph, catalog, claimed);
  applyEventEdges(graph, runEventEngine({ facts }));
}
