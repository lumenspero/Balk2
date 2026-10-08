import type { ConnectionMap, Relationship, RelationshipType } from './types.js';

/**
 * Reading the graph without caring how it was stored.
 *
 * Version 1 maps store both directions of some relationships (`imports` and `importedBy`).
 * Later versions derive reverse links instead. These helpers give the same answer for both: they
 * normalize every stored reverse link to its forward relationship, so "who calls X?" is always
 * `getIncoming(map, X, 'calls')`.
 */

const REVERSE_TO_FORWARD: Readonly<Partial<Record<RelationshipType, RelationshipType>>> = {
  importedBy: 'imports',
  calledBy: 'calls',
  generatedBy: 'generates',
  consumedBy: 'consumes',
};

const CONFIDENCE_RANK = { low: 0, medium: 1, high: 2 } as const;

interface ForwardIndex {
  readonly all: readonly Relationship[];
  readonly outgoing: ReadonlyMap<string, readonly Relationship[]>;
  readonly incoming: ReadonlyMap<string, readonly Relationship[]>;
}

const indexes = new WeakMap<ConnectionMap, ForwardIndex>();

/**
 * Every relationship in forward form: stored reverse links are turned around, repeated
 * (type, from, to) facts are merged keeping the highest confidence, and the result is sorted
 * by (type, from, to).
 */
export function forwardRelationships(map: ConnectionMap): readonly Relationship[] {
  return forwardIndex(map).all;
}

/** Forward relationships that start at `id`, optionally limited to some types. */
export function getOutgoing(
  map: ConnectionMap,
  id: string,
  ...types: readonly RelationshipType[]
): readonly Relationship[] {
  return filterByType(forwardIndex(map).outgoing.get(id), types);
}

/** Forward relationships that end at `id`, optionally limited to some types. */
export function getIncoming(
  map: ConnectionMap,
  id: string,
  ...types: readonly RelationshipType[]
): readonly Relationship[] {
  return filterByType(forwardIndex(map).incoming.get(id), types);
}

/** What reacts when a node publishes to an event channel. */
export interface EventReaction {
  readonly channel: string;
  readonly via: 'emits' | 'dispatches';
  /** Symbols or files that subscribe to the channel, sorted */
  readonly subscribers: readonly string[];
}

/** What can cause a node to run, when it subscribes to an event channel. */
export interface EventTrigger {
  readonly channel: string;
  /** Symbols or files that emit or dispatch to the channel, sorted */
  readonly publishers: readonly string[];
}

/**
 * For each event channel `nodeId` emits or dispatches to, the nodes that subscribe to it:
 * the static answer to "what happens when this fires?". Unresolved observations are not
 * channels and are never reported.
 */
export function getEventReactions(map: ConnectionMap, nodeId: string): EventReaction[] {
  return getOutgoing(map, nodeId, 'emits', 'dispatches')
    .filter((rel) => map.eventChannels[rel.to] !== undefined)
    .map((rel) => ({
      channel: rel.to,
      via: rel.type as 'emits' | 'dispatches',
      subscribers: distinctSources(getIncoming(map, rel.to, 'subscribes')),
    }))
    .sort((a, b) => compareStrings(a.channel, b.channel) || compareStrings(a.via, b.via));
}

/**
 * For each event channel `nodeId` subscribes to, the nodes that publish to it: the static
 * answer to "what can make this run?".
 */
export function getEventTriggers(map: ConnectionMap, nodeId: string): EventTrigger[] {
  return getOutgoing(map, nodeId, 'subscribes')
    .filter((rel) => map.eventChannels[rel.to] !== undefined)
    .map((rel) => ({
      channel: rel.to,
      publishers: distinctSources(getIncoming(map, rel.to, 'emits', 'dispatches')),
    }))
    .sort((a, b) => compareStrings(a.channel, b.channel));
}

function forwardIndex(map: ConnectionMap): ForwardIndex {
  const cached = indexes.get(map);
  if (cached) return cached;

  const merged = new Map<string, Relationship>();
  for (const stored of map.relationships) {
    const forwardType = REVERSE_TO_FORWARD[stored.type];
    const rel: Relationship = forwardType
      ? { ...stored, type: forwardType, from: stored.to, to: stored.from }
      : stored;

    const key = `${rel.type}\u0000${rel.from}\u0000${rel.to}`;
    const existing = merged.get(key);
    if (!existing || CONFIDENCE_RANK[rel.confidence] > CONFIDENCE_RANK[existing.confidence]) {
      merged.set(key, rel);
    }
  }

  const all = [...merged.values()].sort(
    (a, b) =>
      compareStrings(a.type, b.type) ||
      compareStrings(a.from, b.from) ||
      compareStrings(a.to, b.to),
  );

  const outgoing = new Map<string, Relationship[]>();
  const incoming = new Map<string, Relationship[]>();
  for (const rel of all) {
    outgoing.set(rel.from, [...(outgoing.get(rel.from) ?? []), rel]);
    incoming.set(rel.to, [...(incoming.get(rel.to) ?? []), rel]);
  }

  const index: ForwardIndex = { all, outgoing, incoming };
  indexes.set(map, index);
  return index;
}

function filterByType(
  relationships: readonly Relationship[] | undefined,
  types: readonly RelationshipType[],
): readonly Relationship[] {
  if (!relationships) return [];
  return types.length === 0
    ? relationships
    : relationships.filter((rel) => types.includes(rel.type));
}

function distinctSources(relationships: readonly Relationship[]): string[] {
  return [...new Set(relationships.map((rel) => rel.from))].sort(compareStrings);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
