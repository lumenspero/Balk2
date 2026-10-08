import type {
  FileNode,
  SymbolNode,
  SymbolType,
  ArtifactNode,
  ArtifactFormat,
  EventChannelNode,
  UnresolvedReferenceNode,
  Relationship,
  RelationshipDetail,
  RelationshipType,
  Confidence,
  ConnectionMap,
  RepositoryMetadata,
  SourceSpan,
} from './types.js';

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
   * The from/to identifiers are normalized. A relationship is identified by
   * (type, from, to): adding it again merges into the existing one — the higher confidence
   * (and its evidence) wins, source spans are combined, and existing metadata takes
   * precedence. Returns the relationship that is kept.
   */
  addRelationship(
    type: RelationshipType,
    from: string,
    to: string,
    confidence: Confidence = 'high',
    detail: RelationshipDetail = {},
  ): Relationship {
    const rel: Relationship = {
      type,
      from: normalizePath(from),
      to: normalizePath(to),
      confidence,
      ...(detail.evidence ? { evidence: detail.evidence } : {}),
      ...(detail.spans && detail.spans.length > 0 ? { spans: sortSpans(detail.spans) } : {}),
      ...(detail.metadata ? { metadata: detail.metadata } : {}),
    };

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
      unresolved: sortedRecord(this.unresolved),
      relationships: [...this.relationships].sort(compareRelationships),
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────

/** Normalize a path to forward slashes and remove leading ./ */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

const CONFIDENCE_RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

/** Id of an event channel node; shared with analyzers that need to name channels. */
export function eventChannelId(name: string, scope?: string): string {
  return scope ? `event:${normalizePath(scope)}#${name}` : `event:${name}`;
}

function unresolvedId(reason: string, location: SourceSpan): string {
  return `unresolved:${reason}:${normalizePath(location.filePath)}:${location.startLine}:${location.startColumn}`;
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

function sortSpans(spans: readonly SourceSpan[]): SourceSpan[] {
  const unique = new Map(
    spans.map((span) => [
      `${span.filePath}\u0000${span.startLine}:${span.startColumn}-${span.endLine}:${span.endColumn}`,
      { ...span, filePath: normalizePath(span.filePath) },
    ]),
  );
  return [...unique.values()].sort(compareSpans);
}

/** Combine two observations of the same (type, from, to). */
function mergeRelationships(existing: Relationship, incoming: Relationship): Relationship {
  const stronger =
    CONFIDENCE_RANK[incoming.confidence] > CONFIDENCE_RANK[existing.confidence]
      ? incoming
      : existing;
  const evidence = stronger.evidence ?? existing.evidence ?? incoming.evidence;
  const spans = sortSpans([...(existing.spans ?? []), ...(incoming.spans ?? [])]);
  const metadata =
    existing.metadata || incoming.metadata
      ? { ...incoming.metadata, ...existing.metadata }
      : undefined;

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

/**
 * Ordinal (UTF-16 code unit) comparison. `localeCompare` depends on the host's ICU data and
 * locale, which would make the generated map differ between machines.
 */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Sort a Map's entries by key and return a plain object. */
function sortedRecord<T>(map: Map<string, T>): Record<string, T> {
  const entries = [...map.entries()].sort(([a], [b]) => compareStrings(a, b));
  return Object.fromEntries(entries) as Record<string, T>;
}

/** Comparator for deterministic relationship ordering. */
function compareRelationships(a: Relationship, b: Relationship): number {
  return (
    compareStrings(a.type, b.type) || compareStrings(a.from, b.from) || compareStrings(a.to, b.to)
  );
}
