import { normalizePath } from './path-utils.js';
import type {
  Confidence,
  Relationship,
  RelationshipMetadata,
  RelationshipType,
  SourceSpan,
} from './types.js';

/**
 * Reverse relationship types, and the forward type each one is the reverse of.
 *
 * Version 1 maps stored both directions of some relationships. A relationship is now stored once,
 * in its forward direction (`imports`, `calls`, `generates`, `consumes`); the reverse is derived
 * when reading. These names remain only so older maps can be read, and so a caller that still
 * passes one gets the forward relationship stored.
 */
export const REVERSE_TO_FORWARD: Readonly<Partial<Record<RelationshipType, RelationshipType>>> = {
  importedBy: 'imports',
  calledBy: 'calls',
  generatedBy: 'generates',
  consumedBy: 'consumes',
};

export const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

/**
 * Metadata keys whose values are joined across observations of one relationship, rather than
 * dropped when the observations disagree. `loadKind` lists every way a file is loaded, so a file
 * that is both statically imported and dynamically loaded says so. Every other key (`once`, for
 * example) stays strict: it is claimed only when all observations agree.
 */
export const COMBINABLE_METADATA: ReadonlySet<string> = new Set(['loadKind']);

/**
 * Ordinal (UTF-16 code unit) comparison. `localeCompare` depends on the host's ICU data and
 * locale, which would make the generated map differ between machines.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A relationship in forward form: a reverse link is turned around, anything else is unchanged. */
export function toForward(rel: Relationship): Relationship {
  const forward = REVERSE_TO_FORWARD[rel.type];
  return forward ? { ...rel, type: forward, from: rel.to, to: rel.from } : rel;
}

/**
 * Every relationship in canonical form: reverse links turned around, repeated (type, from, to)
 * facts merged, and the result sorted by (type, from, to). Reading an older map through this
 * gives the same relationships a freshly built one would have.
 */
export function canonicalRelationships(relationships: readonly Relationship[]): Relationship[] {
  const merged = new Map<string, Relationship>();

  for (const stored of relationships) {
    const rel = toForward(stored);
    const key = `${rel.type}\u0000${rel.from}\u0000${rel.to}`;
    const existing = merged.get(key);
    merged.set(key, existing ? mergeRelationships(existing, rel) : rel);
  }

  return [...merged.values()].sort(compareRelationships);
}

/** Comparator for deterministic relationship ordering. */
export function compareRelationships(a: Relationship, b: Relationship): number {
  return (
    compareStrings(a.type, b.type) || compareStrings(a.from, b.from) || compareStrings(a.to, b.to)
  );
}

function compareSpans(a: SourceSpan, b: SourceSpan): number {
  return (
    compareStrings(a.filePath, b.filePath) ||
    a.startLine - b.startLine ||
    a.startColumn - b.startColumn ||
    a.endLine - b.endLine ||
    a.endColumn - b.endColumn
  );
}

/** Distinct spans, with normalized paths, in source order. */
export function sortSpans(spans: readonly SourceSpan[]): SourceSpan[] {
  const unique = new Map(
    spans.map((span) => [
      `${span.filePath}\u0000${span.startLine}:${span.startColumn}-${span.endLine}:${span.endColumn}`,
      { ...span, filePath: normalizePath(span.filePath) },
    ]),
  );
  return [...unique.values()].sort(compareSpans);
}

/** The values a combinable key carries, split from its joined form. */
function valuesOf(value: string | number | boolean | undefined): string[] {
  if (value === undefined) return [];
  return String(value)
    .split(',')
    .filter((part) => part.length > 0);
}

/**
 * Metadata for a merged relationship. A combinable key takes the sorted union of the values every
 * observation carries for it. Any other key is kept only when both observations have the same
 * value, so a flag seen on one registration is never claimed for all of them.
 */
function mergeMetadata(
  first: RelationshipMetadata | undefined,
  second: RelationshipMetadata | undefined,
): RelationshipMetadata | undefined {
  const keys = [...new Set([...Object.keys(first ?? {}), ...Object.keys(second ?? {})])].sort(
    compareStrings,
  );
  const merged: Record<string, string | number | boolean> = {};

  for (const key of keys) {
    const a = first?.[key];
    const b = second?.[key];

    if (COMBINABLE_METADATA.has(key)) {
      const values = [...new Set([...valuesOf(a), ...valuesOf(b)])].sort(compareStrings);
      if (values.length > 0) merged[key] = values.join(',');
    } else if (a !== undefined && a === b) {
      merged[key] = a;
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Combine two observations of the same (type, from, to): the higher confidence (and its evidence)
 * wins, spans are combined, and metadata is merged by `mergeMetadata`.
 */
export function mergeRelationships(existing: Relationship, incoming: Relationship): Relationship {
  const stronger =
    CONFIDENCE_RANK[incoming.confidence] > CONFIDENCE_RANK[existing.confidence]
      ? incoming
      : existing;
  const evidence = stronger.evidence ?? existing.evidence ?? incoming.evidence;
  const spans = sortSpans([...(existing.spans ?? []), ...(incoming.spans ?? [])]);
  const metadata = mergeMetadata(existing.metadata, incoming.metadata);

  return {
    type: existing.type,
    from: existing.from,
    to: existing.to,
    confidence: stronger.confidence,
    ...(evidence ? { evidence } : {}),
    ...(spans.length > 0 ? { spans } : {}),
    ...(metadata ? { metadata } : {}),
  };
}