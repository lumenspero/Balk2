import type { BindingConsumer, BindingExport, BindingMatch, FrontEndBindings } from './types.js';

export type {
  BindingConsumer,
  BindingExport,
  BindingKind,
  BindingMatch,
  FrontEndBindings,
} from './types.js';

/**
 * Every producer's exports, keyed by kind and specifier, then by name. Built once per analysis from
 * the front ends' results (V3 step 4). Consumers are matched against it in step 5.
 */
export class BindingIndex {
  private readonly exportsByKey = new Map<string, Map<string, BindingExport[]>>();
  private readonly specifiers = new Set<string>();

  constructor(exports: readonly BindingExport[]) {
    // Sorted so that the candidate lists and the index are the same whatever order the front
    // ends ran in.
    const sorted = [...exports].sort(compareExports);
    for (const entry of sorted) {
      const key = keyOf(entry.kind, entry.specifier);
      this.specifiers.add(key);
      let byName = this.exportsByKey.get(key);
      if (!byName) {
        byName = new Map();
        this.exportsByKey.set(key, byName);
      }
      const list = byName.get(entry.name) ?? [];
      list.push(entry);
      byName.set(entry.name, list);
    }
  }

  /** Whether any producer publishes this kind and specifier. */
  hasProducer(kind: BindingConsumer['kind'], specifier: string): boolean {
    return this.specifiers.has(keyOf(kind, specifier));
  }

  /** Match one consumer against the producers that publish its kind and specifier. */
  match(consumer: BindingConsumer): BindingMatch {
    const key = keyOf(consumer.kind, consumer.specifier);
    const byName = this.exportsByKey.get(key);
    if (!byName) return { status: 'no-producer' };
    const candidates = byName.get(consumer.name);
    if (!candidates || candidates.length === 0) return { status: 'missing-name' };
    if (candidates.length > 1) return { status: 'ambiguous', candidates };
    const only = candidates[0];
    if (!only) return { status: 'missing-name' };
    return { status: 'matched', export: only };
  }
}

/** Build the index from every front end's published bindings. Front ends with none contribute nothing. */
export function buildBindingIndex(
  results: readonly (FrontEndBindings | undefined)[],
): BindingIndex {
  const exports = results.flatMap((result) => result?.exports ?? []);
  return new BindingIndex(exports);
}

/** Every front end's consumers, in a stable order. */
export function collectConsumers(
  results: readonly (FrontEndBindings | undefined)[],
): BindingConsumer[] {
  return results
    .flatMap((result) => result?.consumers ?? [])
    .sort((a, b) => compareConsumers(a, b));
}

/**
 * Step 5, cross-language resolution: match every consumer against the index and return the outcome
 * for each. Edges are emitted for matched consumers in Phase 14.2 to 14.4. Until a producer
 * exists, every consumer is `no-producer`, so the graph is unchanged.
 */
export function resolveBindingConsumers(
  index: BindingIndex,
  consumers: readonly BindingConsumer[],
): { consumer: BindingConsumer; match: BindingMatch }[] {
  return consumers.map((consumer) => ({ consumer, match: index.match(consumer) }));
}

function keyOf(kind: string, specifier: string): string {
  return `${kind}\u0000${specifier}`;
}

function compareExports(a: BindingExport, b: BindingExport): number {
  return (
    compareText(a.kind, b.kind) ||
    compareText(a.specifier, b.specifier) ||
    compareText(a.name, b.name) ||
    compareText(a.file, b.file) ||
    compareText(a.symbolId, b.symbolId)
  );
}

function compareConsumers(a: BindingConsumer, b: BindingConsumer): number {
  return (
    compareText(a.file, b.file) ||
    a.span.startLine - b.span.startLine ||
    a.span.startColumn - b.span.startColumn ||
    compareText(a.kind, b.kind) ||
    compareText(a.specifier, b.specifier) ||
    compareText(a.name, b.name)
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
