import type {
  FileNode,
  SymbolNode,
  SymbolType,
  ArtifactNode,
  ArtifactFormat,
  EventChannelNode,
  RegistryKeyNode,
  RegistryKeyType,
  UnresolvedReferenceNode,
  Relationship,
  RelationshipDetail,
  RelationshipType,
  Confidence,
  ConnectionMap,
  RepositoryMetadata,
  SourceSpan,
} from './types.js';
import { normalizePath } from './path-utils.js';
import {
  compareRelationships,
  compareStrings,
  mergeRelationships,
  sortSpans,
  toForward,
} from './relationship-types.js';

export { normalizePath };

/**
 * Mutable graph builder for constructing a ConnectionMap.
 *
 * Usage:
 *   const graph = new ConnectionGraph();
 *   graph.addFile('src/main.ts', 'typescript');
 *   graph.addRelationship('imports', 'src/main.ts', 'src/util.ts');
 *   const map = graph.build(metadata);
 */
export class ConnectionGraph {
  private readonly files = new Map<string, FileNode>();
  private readonly symbols = new Map<string, SymbolNode>();
  private readonly artifacts = new Map<string, ArtifactNode>();
  private readonly eventChannels = new Map<string, EventChannelNode>();
  private readonly registryKeys = new Map<string, RegistryKeyNode>();
  private readonly unresolved = new Map<string, UnresolvedReferenceNode>();
  private readonly relationships: Relationship[] = [];
  private readonly relationshipIndex = new Map<string, number>();

  /**
   * Add a code file node to the graph.
   * If a file with the same path already exists, it is replaced.
   */
  addFile(path: string, language?: string): FileNode {
    const normalized = normalizePath(path);
    const node: FileNode = { kind: 'file', path: normalized, ...(language ? { language } : {}) };
    this.files.set(normalized, node);
    return node;
  }

  /**
   * Add a code symbol node to the graph.
   * The symbol id is constructed as "filePath:symbolName".
   */
  addSymbol(filePath: string, name: string, symbolType: SymbolType): SymbolNode {
    const normalizedPath = normalizePath(filePath);
    const id = `${normalizedPath}:${name}`;
    const node: SymbolNode = { kind: 'symbol', id, filePath: normalizedPath, name, symbolType };
    this.symbols.set(id, node);
    return node;
  }

  /**
   * Add a data artifact node to the graph.
   */
  addArtifact(path: string, format: ArtifactFormat): ArtifactNode {
    const normalized = normalizePath(path);
    const node: ArtifactNode = { kind: 'artifact', path: normalized, format };
    this.artifacts.set(normalized, node);
    return node;
  }

  /**
   * Add an event channel node. The id is `event:<name>`, or `event:<scope>#<name>` when the
   * channel is scoped by a resolved emitter/receiver identity. Adding it again is a no-op.
   */
  addEventChannel(name: string, scope?: string): EventChannelNode {
    const id = eventChannelId(name, scope);
    const existing = this.eventChannels.get(id);
    if (existing) return existing;

    const node: EventChannelNode = {
      kind: 'event-channel',
      id,
      name,
      ...(scope ? { scope: normalizePath(scope) } : {}),
    };
    this.eventChannels.set(id, node);
    return node;
  }

  /**
   * Add a registry-key node: a key scoped to a resolved registry identity. The id is
   * `registry:<scope>#<key>`, or `registry:<scope>#number:<key>` for a numeric key in a typed
   * registry, so the same key in two registries is two nodes. Adding it again is a no-op.
   */
  addRegistryKey(key: string, scope: string, keyType: RegistryKeyType = 'string'): RegistryKeyNode {
    const normalizedScope = normalizePath(scope);
    const id = registryKeyId(key, normalizedScope, keyType);
    const existing = this.registryKeys.get(id);
    if (existing) return existing;

    const node: RegistryKeyNode = {
      kind: 'registry-key',
      id,
      key,
      scope: normalizedScope,
      keyType,
    };
    this.registryKeys.set(id, node);
    return node;
  }

  /**
   * Add a diagnostic node for code that looks like a connection but could not be resolved.
   * The id is derived from the reason and source location, so re-adding is a no-op.
   */
  addUnresolved(input: Omit<UnresolvedReferenceNode, 'kind' | 'id'>): UnresolvedReferenceNode {
    const { location } = input;
    const id = unresolvedId(input.reason, location);
    const existing = this.unresolved.get(id);
    if (existing) return existing;

    const node: UnresolvedReferenceNode = {
      kind: 'unresolved-reference',
      id,
      reason: input.reason,
      attempted: input.attempted,
      subject: input.subject,
      location: { ...location, filePath: normalizePath(location.filePath) },
      ...(input.candidates ? { candidates: [...input.candidates].sort(compareStrings) } : {}),
      ...(input.detail ? { detail: input.detail } : {}),
    };
    this.unresolved.set(id, node);
    return node;
  }

  /**
   * Add a typed relationship to the graph.
   * The from/to identifiers are normalized. A relationship is stored once, in its forward
   * direction: a reverse type (`importedBy`, `calledBy`, `generatedBy`, `consumedBy`) is accepted
   * and stored as the forward relationship, so callers that still pass one cannot put a duplicate
   * pair in the map. A relationship is identified by
   * (type, from, to): adding it again merges into the existing one — the higher confidence
   * (and its evidence) wins, source spans are combined, and only metadata that holds for every
   * observation is kept. Returns the relationship that is kept.
   */
  addRelationship(
    type: RelationshipType,
    from: string,
    to: string,
    confidence: Confidence = 'high',
    detail: RelationshipDetail = {},
  ): Relationship {
    const rel = toForward({
      type,
      from: normalizePath(from),
      to: normalizePath(to),
      confidence,
      ...(detail.evidence ? { evidence: detail.evidence } : {}),
      ...(detail.spans && detail.spans.length > 0 ? { spans: sortSpans(detail.spans) } : {}),
      ...(detail.metadata ? { metadata: detail.metadata } : {}),
    });

    const key = `${rel.type}\u0000${rel.from}\u0000${rel.to}`;
    const existingIndex = this.relationshipIndex.get(key);
    if (existingIndex !== undefined) {
      const merged = mergeRelationships(this.relationships[existingIndex] as Relationship, rel);
      this.relationships[existingIndex] = merged;
      return merged;
    }

    this.relationshipIndex.set(key, this.relationships.length);
    this.relationships.push(rel);
    return rel;
  }

  /** Returns true if a file node exists for the given path. */
  hasFile(path: string): boolean {
    return this.files.has(normalizePath(path));
  }

  /** Returns true if a symbol node exists for the given id. */
  hasSymbol(id: string): boolean {
    return this.symbols.has(id);
  }

  /** Returns true if an artifact node exists for the given path. */
  hasArtifact(path: string): boolean {
    return this.artifacts.has(normalizePath(path));
  }

  /** Returns true if an event channel node exists for the given id. */
  hasEventChannel(id: string): boolean {
    return this.eventChannels.has(id);
  }

  /** Returns true if a registry-key node exists for the given id. */
  hasRegistryKey(id: string): boolean {
    return this.registryKeys.has(id);
  }

  /** Returns true if an unresolved-reference node exists for the given id. */
  hasUnresolved(id: string): boolean {
    return this.unresolved.has(id);
  }

  /** Returns the file node for the given path, or undefined. */
  getFile(path: string): FileNode | undefined {
    return this.files.get(normalizePath(path));
  }

  /** Returns the symbol node for the given id, or undefined. */
  getSymbol(id: string): SymbolNode | undefined {
    return this.symbols.get(id);
  }

  /** Returns the artifact node for the given path, or undefined. */
  getArtifact(path: string): ArtifactNode | undefined {
    return this.artifacts.get(normalizePath(path));
  }

  /** Returns all relationships, optionally filtered by a node identifier. */
  getRelationships(nodeId?: string): readonly Relationship[] {
    if (!nodeId) return this.relationships;
    const normalized = normalizePath(nodeId);
    return this.relationships.filter((r) => r.from === normalized || r.to === normalized);
  }

  /** Returns the count of all nodes in the graph. */
  get nodeCount(): number {
    return (
      this.files.size +
      this.symbols.size +
      this.artifacts.size +
      this.eventChannels.size +
      this.registryKeys.size +
      this.unresolved.size
    );
  }

  /** Returns the count of all relationships in the graph. */
  get relationshipCount(): number {
    return this.relationships.length;
  }

  /**
   * Build the immutable ConnectionMap from the current graph state.
   * Output is deterministic: nodes are sorted by key, relationships
   * are sorted by (type, from, to), all with locale-independent ordinal
   * string comparison.
   */
  build(metadata: RepositoryMetadata): ConnectionMap {
    return {
      version: 2,
      repository: metadata,
      files: sortedRecord(this.files),
      symbols: sortedRecord(this.symbols),
      artifacts: sortedRecord(this.artifacts),
      eventChannels: sortedRecord(this.eventChannels),
      registryKeys: sortedRecord(this.registryKeys),
      unresolved: sortedRecord(this.unresolved),
      relationships: [...this.relationships].sort(compareRelationships),
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────

/** Id of an event channel node; shared with analyzers that need to name channels. */
export function eventChannelId(name: string, scope?: string): string {
  return scope ? `event:${normalizePath(scope)}#${name}` : `event:${name}`;
}

/**
 * Id of a registry-key node; shared with analyzers that need to name keys. A numeric key in a
 * typed registry is tagged, so `1` and `'1'` stay apart there.
 */
export function registryKeyId(
  key: string,
  scope: string,
  keyType: RegistryKeyType = 'string',
): string {
  const tag = keyType === 'number' ? 'number:' : '';
  return `registry:${normalizePath(scope)}#${tag}${key}`;
}

function unresolvedId(reason: string, location: SourceSpan): string {
  return `unresolved:${reason}:${normalizePath(location.filePath)}:${location.startLine}:${location.startColumn}`;
}

/** Sort a Map's entries by key and return a plain object. */
function sortedRecord<T>(map: Map<string, T>): Record<string, T> {
  const entries = [...map.entries()].sort(([a], [b]) => compareStrings(a, b));
  return Object.fromEntries(entries) as Record<string, T>;
}
