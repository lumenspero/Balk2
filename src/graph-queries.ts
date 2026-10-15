import { canonicalRelationships, compareStrings } from './relationship-types.js';
import type { ConnectionMap, Relationship, RelationshipType } from './types.js';

/**
 * Reading the graph without caring how it was stored.
 *
 * A relationship is stored once, in its forward direction. Version 1 maps also stored a reverse
 * link for some families (`imports` and `importedBy`). These helpers give the same answer for
 * both: they normalize any stored reverse link to its forward relationship, so "who calls X?" is
 * always `getIncoming(map, X, 'calls')`.
 */

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

/** A registry key a node looks up, and the symbols or files that key is registered to. */
export interface RegistryResolution {
  readonly key: string;
  readonly relationship: 'resolves' | 'routesTo';
  /** Symbols or files the key maps to, sorted */
  readonly targets: readonly string[];
}

/**
 * For each registry key `nodeId` looks up, what that key is registered to: the static answer to
 * "where does this lookup go?". A key with no registration has no targets.
 */
export function getRegistryResolutions(map: ConnectionMap, nodeId: string): RegistryResolution[] {
  return getOutgoing(map, nodeId, 'resolves', 'routesTo')
    .filter((rel) => map.registryKeys[rel.to] !== undefined)
    .map((rel) => ({
      key: rel.to,
      relationship: rel.type as 'resolves' | 'routesTo',
      targets: getRegistrationTargets(map, rel.to),
    }))
    .sort((a, b) => compareStrings(a.key, b.key) || compareStrings(a.relationship, b.relationship));
}

/** Symbols or files a registry key is registered to, sorted. */
export function getRegistrationTargets(map: ConnectionMap, keyId: string): string[] {
  const targets = getOutgoing(map, keyId, 'registers').map((rel) => rel.to);
  return [...new Set(targets)].sort(compareStrings);
}

/** Nodes that look up a registry key with `resolves` or `routesTo`, sorted. */
export function getRegistryLookups(map: ConnectionMap, keyId: string): string[] {
  return distinctSources(getIncoming(map, keyId, 'resolves', 'routesTo'));
}

function forwardIndex(map: ConnectionMap): ForwardIndex {
  const cached = indexes.get(map);
  if (cached) return cached;

  const all = canonicalRelationships(map.relationships);

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
