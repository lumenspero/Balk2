import type { ConnectionGraph } from '../../graph.js';
import { resolveBindingConsumers, type BindingIndex } from './index.js';
import type { BindingConsumer, BindingMatch } from './types.js';

/** One consumer and its outcome against the index. */
export interface BindingResolution {
  readonly consumer: BindingConsumer;
  readonly match: BindingMatch;
}

/**
 * Step 5, cross-language resolution (V3 Phase 14.2). A matched binding becomes a graph edge:
 *
 * - A Rust export imported by JS/TS: `calls` from the consumer (its owner, or its file) to the
 *   exported Rust function.
 * - A JS/TS module imported by a Rust extern block: `imports` from the Rust file to the module
 *   (`wasm-bindgen-module`), and `calls` from the extern fn to the JS export.
 *
 * An edge is written only when both ends exist in the graph. Ambiguous and unmatched consumers
 * write nothing.
 */
export function connectBindings(
  graph: ConnectionGraph,
  index: BindingIndex,
  consumers: readonly BindingConsumer[],
): BindingResolution[] {
  const resolutions = resolveBindingConsumers(index, consumers);
  for (const { consumer, match } of resolutions) {
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
