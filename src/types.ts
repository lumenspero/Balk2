/**
 * Core type definitions for the Balk2 connection map graph model (schema version 2).
 *
 * The graph supports file, symbol and artifact nodes plus virtual nodes for indirect
 * mechanisms (event channels) and diagnostics (unresolved references), connected by
 * typed directional relationships. See docs/connection-map-schema.md.
 */

// ── Node Types ──────────────────────────────────────────────

export type NodeKind =
  'file' | 'symbol' | 'artifact' | 'event-channel' | 'unresolved-reference' | 'registry-key';

/**
 * A code file node in the graph.
 *
 * Examples: src/main.ts, scripts/build.js
 */
export interface FileNode {
  readonly kind: 'file';
  /** Repository-relative path (forward slashes, e.g. "src/main.ts") */
  readonly path: string;
  /** Detected language, if recognized */
  readonly language?: string;
}

/**
 * A code symbol node in the graph.
 *
 * Examples: src/state/state.ts:updateState, src/sim/sim.ts:step
 */
export interface SymbolNode {
  readonly kind: 'symbol';
  /** Unique identifier: "filePath:symbolName" */
  readonly id: string;
  /** Repository-relative path of the containing file */
  readonly filePath: string;
  /** Symbol name (function, class, method, etc.) */
  readonly name: string;
  /** Symbol type classification */
  readonly symbolType: SymbolType;
}

export type SymbolType = 'function' | 'class' | 'method' | 'type' | 'constant' | 'variable';

/**
 * A data artifact node in the graph.
 *
 * Examples: data/source.json, data/titles.parquet
 */
export interface ArtifactNode {
  readonly kind: 'artifact';
  /** Repository-relative path */
  readonly path: string;
  /** Recognized data format */
  readonly format: ArtifactFormat;
}

export type ArtifactFormat =
  'json' | 'jsonl' | 'csv' | 'tsv' | 'parquet' | 'yaml' | 'toml' | 'xml' | 'sqlite' | 'unknown';

/**
 * A virtual node for an event name, optionally scoped by the resolved identity of the
 * emitter/receiver, so unrelated event systems that reuse a name stay separate.
 *
 * Examples: event:ready, event:src/net.ts:socket#ready, event:global:document#click
 */
export interface EventChannelNode {
  readonly kind: 'event-channel';
  /** Unique identifier: "event:<name>" or "event:<scope>#<name>" */
  readonly id: string;
  /** Normalized event name */
  readonly name: string;
  /** Resolved receiver identity that scopes the channel, when known */
  readonly scope?: string;
}

/**
 * How a key is typed in its registry. A dictionary stores `1` and `'1'` as one key, so its keys
 * are `string`. A Map, Set or class keeps `1` and `'1'` apart, so a numeric key is `number`.
 */
export type RegistryKeyType = 'string' | 'number';

/**
 * A virtual node for a key scoped to a resolved registry identity, such as a key used to look up
 * a factory, a route or a plugin.
 *
 * Examples: registry:src/container.ts:container#user, registry:src/cache.ts:store#number:404
 */
export interface RegistryKeyNode {
  readonly kind: 'registry-key';
  /** Unique identifier: "registry:<scope>#<key>", or "registry:<scope>#number:<key>" */
  readonly id: string;
  /** The key, as a string */
  readonly key: string;
  /** Resolved identity of the registry the key belongs to */
  readonly scope: string;
  /** Whether the key is a string or a number; numeric keys appear only in typed registries */
  readonly keyType: RegistryKeyType;
}

/** Why a relationship could not be resolved to a concrete target. */
export type UnresolvedReason =
  | 'ambiguous-global'
  | 'dynamic-event-name'
  | 'unknown-event-receiver'
  | 'dynamic-registry-key'
  | 'unknown-registry-receiver';

/**
 * A diagnostic-only node recording code that looks like a connection but could not be
 * resolved. It is linked from the owning symbol or file by a low-confidence relationship
 * of the type that was attempted, so ambiguous or dynamic code never becomes a
 * misleading high-confidence edge.
 */
export interface UnresolvedReferenceNode {
  readonly kind: 'unresolved-reference';
  /** Unique identifier: "unresolved:<reason>:<file>:<line>:<column>" */
  readonly id: string;
  readonly reason: UnresolvedReason;
  /** The relationship that would have been created had the target been known */
  readonly attempted: RelationshipType;
  /** What was being resolved: a global name, an event method call, ... */
  readonly subject: string;
  /** Where the unresolved code is written */
  readonly location: SourceSpan;
  /** Possible targets, when the problem is ambiguity rather than dynamism */
  readonly candidates?: readonly string[];
  /** Why it could not be resolved, in a sentence (for example "receiver type is not known") */
  readonly detail?: string;
}

export type GraphNode =
  | FileNode
  | SymbolNode
  | ArtifactNode
  | EventChannelNode
  | RegistryKeyNode
  | UnresolvedReferenceNode;

/** A 1-based range in a repository file. */
export interface SourceSpan {
  readonly filePath: string;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

// ── Relationship Types ──────────────────────────────────────

/**
 * Code relationships. `importedBy` and `calledBy` are legacy reverse links: they exist so older
 * maps can be read, and `ConnectionGraph.addRelationship` stores their forward form (`imports`,
 * `calls`) instead. A built map never contains them.
 */
export type CodeRelationship =
  | 'imports'
  | 'importedBy'
  | 'calls'
  | 'calledBy'
  | 'extends'
  | 'implements'
  | 'references'
  | 'exports';

/** Event relationships. Reverse links are derived at render/query time, never stored. */
export type EventRelationship = 'emits' | 'subscribes' | 'unsubscribes' | 'dispatches';

/**
 * Registry relationships. `registers` runs from a registry key to the symbol or file it maps to.
 * `resolves` and `routesTo` run from a caller to the registry key it looks up.
 */
export type RegistryRelationship = 'registers' | 'resolves' | 'routesTo';

/** Data relationships. `generatedBy` and `consumedBy` are legacy reverse links, as above. */
export type DataRelationship =
  'generates' | 'generatedBy' | 'consumes' | 'consumedBy' | 'reads' | 'writes' | 'transforms';

export type RelationshipType =
  CodeRelationship | EventRelationship | DataRelationship | RegistryRelationship;

export type Confidence = 'high' | 'medium' | 'low';

/** How a relationship was established. */
export type Evidence = 'ast' | 'ts-program' | 'config' | 'heuristic';

/** Lifecycle and mechanism details such as `{ once: true }` on a subscription. */
export type RelationshipMetadata = Readonly<Record<string, string | number | boolean>>;

/** Optional detail attached to a relationship. */
export interface RelationshipDetail {
  readonly evidence?: Evidence;
  readonly spans?: readonly SourceSpan[];
  readonly metadata?: RelationshipMetadata;
}

/**
 * A typed, directional relationship between two graph nodes.
 */
export interface Relationship extends RelationshipDetail {
  /** The relationship type */
  readonly type: RelationshipType;
  /** The source node identifier (file path, symbol id, artifact path, or virtual node id) */
  readonly from: string;
  /** The target node identifier */
  readonly to: string;
  /** Confidence level of this relationship */
  readonly confidence: Confidence;
}

// ── Connection Map Schema ───────────────────────────────────

/**
 * Repository metadata included in the connection map.
 */
export interface RepositoryMetadata {
  /** Short commit hash, if available */
  readonly commit?: string;
  /** ISO 8601 timestamp of generation */
  readonly generatedAt: string;
}

/**
 * The canonical connection map — the complete graph representation.
 * Serialized directly to connection-map.json.
 */
export interface ConnectionMap {
  /** Schema version */
  readonly version: 2;
  /** Repository metadata */
  readonly repository: RepositoryMetadata;
  /** File nodes keyed by path */
  readonly files: Record<string, FileNode>;
  /** Symbol nodes keyed by id */
  readonly symbols: Record<string, SymbolNode>;
  /** Artifact nodes keyed by path */
  readonly artifacts: Record<string, ArtifactNode>;
  /** Event channel nodes keyed by id */
  readonly eventChannels: Record<string, EventChannelNode>;
  /** Registry-key nodes keyed by id */
  readonly registryKeys: Record<string, RegistryKeyNode>;
  /** Unresolved-reference diagnostics keyed by id */
  readonly unresolved: Record<string, UnresolvedReferenceNode>;
  /** All relationships in the graph */
  readonly relationships: Relationship[];
}

/**
 * The version 1 connection map. Still readable: `deserializeConnectionMap` converts it to
 * version 2 by adding empty virtual-node tables.
 */
export interface ConnectionMapV1 {
  readonly version: 1;
  readonly repository: RepositoryMetadata;
  readonly files: Record<string, FileNode>;
  readonly symbols: Record<string, SymbolNode>;
  readonly artifacts: Record<string, ArtifactNode>;
  readonly relationships: Relationship[];
}
