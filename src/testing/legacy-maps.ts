import type { ConnectionMap, Relationship } from '../types.js';

const REVERSE_OF = {
  imports: 'importedBy',
  calls: 'calledBy',
  generates: 'generatedBy',
  consumes: 'consumedBy',
} as const;

const reverseLinkOf = (rel: Relationship): Relationship | undefined => {
  const type = REVERSE_OF[rel.type as keyof typeof REVERSE_OF];
  return type ? { ...rel, type, from: rel.to, to: rel.from } : undefined;
};

/**
 * A map shaped the way version 1 stored it: every forward relationship also has its reverse link.
 *
 * `ConnectionGraph` no longer produces these, so tests that need one build it by hand here.
 */
export function withStoredReverseLinks(map: ConnectionMap): ConnectionMap {
  const reverse = map.relationships.flatMap((rel) => reverseLinkOf(rel) ?? []);
  return { ...map, relationships: [...map.relationships, ...reverse] };
}

/** A map holding only the reverse links, with the forward relationships removed. */
export function withReverseLinksOnly(map: ConnectionMap): ConnectionMap {
  const relationships = map.relationships.map((rel) => reverseLinkOf(rel) ?? rel);
  return { ...map, relationships };
}

/** The relationship types in a map that are stored reverse links. */
export function storedReverseTypes(map: {
  readonly relationships: readonly Relationship[];
}): string[] {
  const reverse = new Set<string>(Object.values(REVERSE_OF));
  return [
    ...new Set(map.relationships.map((rel) => rel.type).filter((t) => reverse.has(t))),
  ].sort();
}
