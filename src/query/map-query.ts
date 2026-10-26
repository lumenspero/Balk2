import { forwardRelationships } from '../graph-queries.js';
import { normalizePath } from '../path-utils.js';
import { CONFIDENCE_RANK } from '../relationship-types.js';
import type {
  Confidence,
  ConnectionMap,
  NodeKind,
  Relationship,
  RelationshipType,
} from '../types.js';

/** Relationship families a query can select. Each groups the types of one mechanism. */
export const RELATIONSHIP_FAMILIES = [
  'code',
  'events',
  'data',
  'registry',
  'metadata',
  'resources',
  'state',
] as const;
export type RelationshipFamily = (typeof RELATIONSHIP_FAMILIES)[number];

export const NODE_KINDS: readonly NodeKind[] = [
  'file',
  'symbol',
  'artifact',
  'event-channel',
  'unresolved-reference',
  'registry-key',
  'state-path',
  'metadata-key',
  'resource',
  'package',
];

export const CONFIDENCE_LEVELS: readonly Confidence[] = ['high', 'medium', 'low'];

/** Relationships returned when no limit is given. Pass Infinity to remove the limit. */
export const DEFAULT_LIMIT = 200;

/**
 * Confidence used when none is given. Directions the analyzer could only guess are recorded as
 * low, so medium leaves them out unless asked for.
 */
export const DEFAULT_MIN_CONFIDENCE: Confidence = 'medium';

/**
 * Families a focused query follows outward. Direct structural edges come first. Indirect
 * mechanisms (events, data, registries, state) are listed as leaves unless asked for.
 */
export const DEFAULT_TRAVERSE: readonly RelationshipFamily[] = ['code'];

/**
 * A node with more relationships than this is listed but not expanded, so a hub does not pull in
 * the whole repository. The focus itself is always expanded. Pass Infinity to remove the bound.
 */
export const DEFAULT_MAX_DEGREE = 50;

/** Languages a query can filter on. Nodes with no language never exclude a relationship. */
export const LANGUAGES = ['javascript', 'typescript', 'python', 'rust'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Structural edges that describe packaging. They rank after code edges at the same distance. */
const PACKAGING_TYPES: ReadonlySet<RelationshipType> = new Set(['declaresModule', 'packageRoot']);

const FAMILY_TYPES: Readonly<Record<RelationshipFamily, readonly RelationshipType[]>> = {
  code: [
    'imports',
    'importedBy',
    'calls',
    'calledBy',
    'passesCallback',
    'extends',
    'implements',
    'references',
    'exports',
    'declaresModule',
    'dependsOn',
    'packageRoot',
    'executes',
  ],
  events: ['emits', 'subscribes', 'unsubscribes', 'dispatches'],
  data: ['generates', 'generatedBy', 'consumes', 'consumedBy', 'reads', 'writes', 'transforms'],
  registry: ['registers', 'resolves', 'routesTo'],
  metadata: ['definesMetadata', 'readsMetadata'],
  resources: ['usesResource'],
  state: ['readsState', 'writesState', 'deletesState'],
};

export interface QueryOptions {
  /** Families to keep. Omitted means every family. */
  readonly families?: readonly RelationshipFamily[];
  /** Keep relationships at or above this confidence. Defaults to medium. */
  readonly minConfidence?: Confidence;
  /** Keep relationships whose two endpoints both have one of these node kinds. */
  readonly nodeKinds?: readonly NodeKind[];
  /**
   * Keep relationships whose endpoints with a known language are all in this list. A relationship
   * needs at least one such endpoint, so a pipeline of data files alone does not match.
   */
  readonly languages?: readonly Language[];
  /** A file path or node id. Limits the result to the neighborhood of this node. */
  readonly focus?: string;
  /** How many hops out from the focus to follow. Defaults to 1. */
  readonly depth?: number;
  /**
   * Families followed outward from the focus. Each node reached lists all its relationships, but
   * only these families lead onward. Defaults to code.
   */
  readonly traverse?: readonly RelationshipFamily[];
  /** Nodes with more relationships than this are listed but not expanded. Defaults to 50. */
  readonly maxDegree?: number;
  /**
   * Most relationships to return. Defaults to DEFAULT_LIMIT. Pass Infinity for no limit. With a
   * focus, the relationships nearest the focus are kept first.
   */
  readonly limit?: number;
}

export interface QueryResult {
  /** The node the neighborhood was built from, when a focus was given. */
  readonly focus?: string;
  /**
   * Matching relationships in forward form, at most `limit` of them. With a focus they are ordered
   * by distance from the focus, then canonically. Without one they are in canonical order.
   */
  readonly relationships: readonly Relationship[];
  /** How many relationships matched before the limit was applied. */
  readonly total: number;
  /** True when `total` is larger than the number returned. */
  readonly truncated: boolean;
}

/** Raised for requests that cannot be answered: an unknown focus or an invalid depth or limit. */
export class QueryError extends Error {}

/** The kind of node an id names, or undefined when no node table holds it. */
export function nodeKindOf(map: ConnectionMap, id: string): NodeKind | undefined {
  if (hasKey(map.files, id)) return 'file';
  if (hasKey(map.symbols, id)) return 'symbol';
  if (hasKey(map.artifacts, id)) return 'artifact';
  if (hasKey(map.eventChannels, id)) return 'event-channel';
  if (hasKey(map.registryKeys, id)) return 'registry-key';
  if (hasKey(map.metadataKeys, id)) return 'metadata-key';
  if (hasKey(map.resources, id)) return 'resource';
  if (hasKey(map.statePaths, id)) return 'state-path';
  if (hasKey(map.packages, id)) return 'package';
  if (hasKey(map.unresolved, id)) return 'unresolved-reference';
  return undefined;
}

/**
 * Filter the map's relationships and, when a focus is given, keep only the neighborhood of that
 * node. The neighborhood follows relationships in either direction for `depth` hops, expanding
 * only through the traversal families and never through nodes above the degree bound. The result
 * is capped at `limit`.
 */
export function queryRelationships(map: ConnectionMap, options: QueryOptions = {}): QueryResult {
  const depth = options.depth ?? 1;
  if (!Number.isInteger(depth) || depth < 0) {
    throw new QueryError('depth must be a non-negative integer');
  }

  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!isPositiveWholeOrInfinity(limit)) {
    throw new QueryError('limit must be a positive whole number');
  }

  const maxDegree = options.maxDegree ?? DEFAULT_MAX_DEGREE;
  if (!isPositiveWholeOrInfinity(maxDegree)) {
    throw new QueryError('maxDegree must be a positive whole number');
  }

  let seed: string | undefined;
  if (options.focus !== undefined) {
    seed = resolveFocus(map, options.focus);
    if (seed === undefined) throw new QueryError(`no node matches "${options.focus}"`);
  }

  const types = typesFor(options.families);
  const traversable = typesFor(options.traverse ?? DEFAULT_TRAVERSE);
  const minRank = CONFIDENCE_RANK[options.minConfidence ?? DEFAULT_MIN_CONFIDENCE];
  const kinds = options.nodeKinds ? new Set<NodeKind>(options.nodeKinds) : undefined;
  const endpointAllowed = (id: string): boolean => {
    if (kinds === undefined) return true;
    const kind = nodeKindOf(map, id);
    return kind !== undefined && kinds.has(kind);
  };

  const languages = options.languages ? new Set<string>(options.languages) : undefined;
  const languageAllowed = (rel: Relationship): boolean => {
    if (languages === undefined) return true;
    const known = [rel.from, rel.to]
      .map((id) => languageOf(map, id))
      .filter((language): language is string => language !== undefined);
    return known.length > 0 && known.every((language) => languages.has(language));
  };

  const kept = forwardRelationships(map).filter(
    (rel) =>
      types.has(rel.type) &&
      CONFIDENCE_RANK[rel.confidence] >= minRank &&
      endpointAllowed(rel.from) &&
      endpointAllowed(rel.to) &&
      languageAllowed(rel),
  );

  const ordered =
    seed === undefined
      ? kept
      : orderByDistance(kept, neighborhood(kept, seed, depth, traversable, maxDegree));
  const relationships = ordered.slice(0, limit);

  return {
    ...(seed !== undefined ? { focus: seed } : {}),
    relationships,
    total: ordered.length,
    truncated: ordered.length > relationships.length,
  };
}

function isPositiveWholeOrInfinity(value: number): boolean {
  return value === Infinity || (Number.isInteger(value) && value >= 1);
}

function resolveFocus(map: ConnectionMap, focus: string): string | undefined {
  for (const candidate of [focus, normalizePath(focus)]) {
    if (nodeKindOf(map, candidate) !== undefined) return candidate;
  }
  return undefined;
}

/** The filterable language of a node: a file's own tag, or the file a symbol belongs to. */
function languageOf(map: ConnectionMap, id: string): string | undefined {
  const fileId = hasKey(map.symbols, id) ? (map.symbols[id]?.filePath ?? id) : id;
  const language = hasKey(map.files, fileId) ? map.files[fileId]?.language : undefined;
  return language !== undefined && (LANGUAGES as readonly string[]).includes(language)
    ? language
    : undefined;
}

function typesFor(families?: readonly RelationshipFamily[]): ReadonlySet<RelationshipType> {
  const selected = families ?? RELATIONSHIP_FAMILIES;
  return new Set(selected.flatMap((family) => FAMILY_TYPES[family]));
}

/**
 * Relationships incident to expanded nodes within `depth` hops of `seed`, treating edges as
 * undirected. A node is expanded when it is the seed or has at most `maxDegree` relationships.
 * Every relationship on an expanded node is listed, but only traversable ones lead onward, so an
 * indirect node such as an event channel is listed without its other connections. Each listed
 * relationship maps to the hop count at which it was first reached.
 */
function neighborhood(
  relationships: readonly Relationship[],
  seed: string,
  depth: number,
  traversable: ReadonlySet<RelationshipType>,
  maxDegree: number,
): Map<Relationship, number> {
  const incident = new Map<string, Relationship[]>();
  const attach = (id: string, rel: Relationship): void => {
    const list = incident.get(id);
    if (list) list.push(rel);
    else incident.set(id, [rel]);
  };
  for (const rel of relationships) {
    attach(rel.from, rel);
    if (rel.to !== rel.from) attach(rel.to, rel);
  }

  const distance = new Map<string, number>([[seed, 0]]);
  const queue: string[] = [seed];
  const reached = new Map<Relationship, number>();

  while (queue.length > 0) {
    const id = queue.shift();
    if (id === undefined) break;
    const hops = distance.get(id) ?? 0;
    if (hops >= depth) continue;

    const edges = incident.get(id) ?? [];
    // A hub is listed through the edge that reached it, but its own edges are not expanded.
    if (id !== seed && edges.length > maxDegree) continue;

    for (const rel of edges) {
      if (!reached.has(rel)) reached.set(rel, hops + 1);
      if (!traversable.has(rel.type)) continue;

      const other = rel.from === id ? rel.to : rel.from;
      if (!distance.has(other)) {
        distance.set(other, hops + 1);
        queue.push(other);
      }
    }
  }

  return reached;
}

/**
 * Reached relationships sorted by hop count, then code edges before packaging edges, then by their
 * position in the canonical order. Packaging edges are listed last so a limit cuts them first.
 */
function orderByDistance(
  canonical: readonly Relationship[],
  reached: ReadonlyMap<Relationship, number>,
): Relationship[] {
  const position = new Map(canonical.map((rel, index) => [rel, index]));
  const rank = (rel: Relationship): number => (PACKAGING_TYPES.has(rel.type) ? 1 : 0);
  return [...reached.keys()].sort(
    (a, b) =>
      (reached.get(a) ?? 0) - (reached.get(b) ?? 0) ||
      rank(a) - rank(b) ||
      (position.get(a) ?? 0) - (position.get(b) ?? 0),
  );
}

function hasKey(record: object, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, id);
}
