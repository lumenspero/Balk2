import type {
  PackageNode,
  ArtifactNode,
  ConnectionMap,
  EventChannelNode,
  FileNode,
  MetadataKeyNode,
  Relationship,
  RegistryKeyNode,
  ResourceNode,
  StatePathNode,
  SymbolNode,
  UnresolvedReferenceNode,
} from '../types.js';

export interface MapNodes {
  readonly files?: readonly string[];
  readonly symbols?: readonly string[];
  readonly eventChannels?: readonly string[];
}

function table<T>(ids: readonly string[] = []): Record<string, T> {
  return Object.fromEntries(ids.map((id) => [id, {} as T]));
}

/**
 * A connection map whose node records are empty placeholders. Tests that only care about which
 * ids exist and which edges connect them can use this instead of running the analyzer.
 */
export function buildMap(nodes: MapNodes, relationships: readonly Relationship[]): ConnectionMap {
  return {
    version: 3,
    repository: { generatedAt: '2026-01-01T00:00:00.000Z' },
    packages: table<PackageNode>(),
    files: table<FileNode>(nodes.files),
    symbols: table<SymbolNode>(nodes.symbols),
    artifacts: table<ArtifactNode>(),
    eventChannels: table<EventChannelNode>(nodes.eventChannels),
    registryKeys: table<RegistryKeyNode>(),
    metadataKeys: table<MetadataKeyNode>(),
    resources: table<ResourceNode>(),
    statePaths: table<StatePathNode>(),
    unresolved: table<UnresolvedReferenceNode>(),
    relationships: [...relationships],
  };
}
