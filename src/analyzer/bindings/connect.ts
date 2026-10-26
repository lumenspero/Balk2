import type { ConnectionGraph } from '../../graph.js';
import type { RelationshipType } from '../../types.js';
import { resolveBindingConsumers, type BindingIndex } from './index.js';
import type { BindingConsumer, BindingMatch } from './types.js';

/** One consumer and its outcome against the index. */
export interface BindingResolution {
  readonly consumer: BindingConsumer;
  readonly match: BindingMatch;
}

/**
 * Step 5, cross-language resolution (V3 Phase 14.2, 14.6). A matched binding becomes a graph edge:
 *
 * - A Rust export imported by JS/TS: `calls` from the consumer (its owner, or its file) to the
 *   exported Rust function.
 * - A JS/TS module imported by a Rust extern block: `imports` from the Rust file to the module
 *   (`wasm-bindgen-module`), and `calls` from the extern fn to the JS export.
 *
 * A consumer whose module is a binding producer but which names nothing that producer exports is an
 * `unresolved-binding` observation (14.6). A module with no binding producer writes nothing, and
 * an ambiguous consumer writes nothing.
 *
 * An edge is written only when both ends exist in the graph.
 */
export function connectBindings(
  graph: ConnectionGraph,
  index: BindingIndex,
  consumers: readonly BindingConsumer[],
): BindingResolution[] {
  const resolutions = resolveBindingConsumers(index, consumers);
  for (const { consumer, match } of resolutions) {
    if (match.status === 'missing-name') {
      reportUnresolvedBinding(graph, consumer);
      continue;
    }
    if (match.status !== 'matched') continue;
    const producer = match.export;
    const spans = [consumer.span];

    if (producer.side === 'rust') {
      const from = consumer.owner ?? consumer.file;
      if (!graph.hasSymbol(producer.symbolId)) continue;
      if (!graph.hasFile(from) && !graph.hasSymbol(from)) continue;
      graph.addRelationship('calls', from, producer.symbolId, producer.confidence, {
        evidence: 'ast',
        spans,
        metadata: { mechanism: producer.kind },
      });
      continue;
    }

    if (!graph.hasFile(producer.file)) continue;
    graph.addRelationship('imports', consumer.file, producer.file, 'high', {
      evidence: 'ast',
      spans,
      metadata: { loadKind: 'wasm-bindgen-module' },
    });
    if (
      consumer.owner !== undefined &&
      graph.hasSymbol(consumer.owner) &&
      graph.hasSymbol(producer.symbolId)
    ) {
      graph.addRelationship('calls', consumer.owner, producer.symbolId, producer.confidence, {
        evidence: 'ast',
        spans,
        metadata: { mechanism: producer.kind },
      });
    }
  }
  return resolutions;
}

/**
 * The consumer names something its binding producer does not export. The observation is written
 * from the consumer, as the relationship it would have made, so the broken binding is visible in
 * the map. It is keyed by the consumer's location, so one consumer reports once.
 */
function reportUnresolvedBinding(graph: ConnectionGraph, consumer: BindingConsumer): void {
  const owner =
    consumer.owner !== undefined && graph.hasSymbol(consumer.owner)
      ? consumer.owner
      : consumer.file;
  if (!graph.hasFile(owner) && !graph.hasSymbol(owner)) return;
  const attempted: RelationshipType = consumer.side === 'rust' ? 'calls' : 'imports';
  const unresolved = graph.addUnresolved({
    reason: 'unresolved-binding',
    attempted,
    subject: `${consumer.specifier}:${consumer.name}`,
    location: consumer.span,
    detail: `${consumer.specifier} is a ${consumer.kind} binding, and it does not export ${consumer.name}`,
  });
  graph.addRelationship(attempted, owner, unresolved.id, 'low', {
    evidence: 'ast',
    spans: [consumer.span],
  });
}
