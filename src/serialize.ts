import { detectManifestKind } from './data/manifests.js';
import { canonicalRelationships, compareStrings } from './relationship-types.js';
import type {
  ArtifactNode,
  ConnectionMap,
  ConnectionMapV1,
  ConnectionMapV2,
  FileNode,
} from './types.js';

/**
 * Serialize a ConnectionMap to a deterministic JSON string.
 * Uses 2-space indentation for readability.
 */
export function serializeConnectionMap(map: ConnectionMap): string {
  return JSON.stringify(map, null, 2) + '\n';
}

/**
 * Deserialize a JSON string to a ConnectionMap (version 3).
 * Performs basic structural validation.
 *
 * Versions 1 and 2 are accepted and upgraded to version 3 (see {@link convertV2ToV3}); any other
 * version is rejected. Relationships are returned in canonical form for every version: reverse
 * links turned around, repeated facts merged, sorted.
 */
export function deserializeConnectionMap(json: string): ConnectionMap {
  const parsed: unknown = JSON.parse(json);

  if (!isObject(parsed)) {
    throw new Error('Invalid connection map: expected an object');
  }

  const obj = parsed as Record<string, unknown>;
  const version = obj['version'];

  if (version !== 1 && version !== 2 && version !== 3) {
    throw new Error(`Unsupported connection map version: ${String(version)}`);
  }

  if (!isObject(obj['repository'])) {
    throw new Error('Invalid connection map: missing repository metadata');
  }

  if (!isObject(obj['files'])) {
    throw new Error('Invalid connection map: missing files');
  }

  if (!isObject(obj['symbols'])) {
    throw new Error('Invalid connection map: missing symbols');
  }

  if (!isObject(obj['artifacts'])) {
    throw new Error('Invalid connection map: missing artifacts');
  }

  if (version !== 1) {
    if (!isObject(obj['eventChannels'])) {
      throw new Error('Invalid connection map: missing eventChannels');
    }

    if (!isObject(obj['unresolved'])) {
      throw new Error('Invalid connection map: missing unresolved');
    }

    if (obj['registryKeys'] !== undefined && !isObject(obj['registryKeys'])) {
      throw new Error('Invalid connection map: registryKeys must be an object');
    }

    if (obj['metadataKeys'] !== undefined && !isObject(obj['metadataKeys'])) {
      throw new Error('Invalid connection map: metadataKeys must be an object');
    }

    if (obj['resources'] !== undefined && !isObject(obj['resources'])) {
      throw new Error('Invalid connection map: resources must be an object');
    }

    if (obj['statePaths'] !== undefined && !isObject(obj['statePaths'])) {
      throw new Error('Invalid connection map: statePaths must be an object');
    }
  }

  if (version === 3 && obj['packages'] !== undefined && !isObject(obj['packages'])) {
    throw new Error('Invalid connection map: packages must be an object');
  }

  if (!Array.isArray(obj['relationships'])) {
    throw new Error('Invalid connection map: missing relationships');
  }

  if (version === 1) {
    return convertV2ToV3(convertV1ToV2(parsed as unknown as ConnectionMapV1));
  }

  if (version === 2) {
    return convertV2ToV3(readV2(parsed as Record<string, unknown>));
  }

  return readV3(parsed as Record<string, unknown>);
}

/**
 * Read a version 2 map. A version 2 map written before registry keys, metadata keys, resources or
 * state paths existed lacks those tables; each reads as empty.
 */
function readV2(obj: Record<string, unknown>): ConnectionMapV2 {
  const map = obj as unknown as Omit<
    ConnectionMapV2,
    'registryKeys' | 'metadataKeys' | 'resources' | 'statePaths'
  > & {
    registryKeys?: ConnectionMapV2['registryKeys'];
    metadataKeys?: ConnectionMapV2['metadataKeys'];
    resources?: ConnectionMapV2['resources'];
    statePaths?: ConnectionMapV2['statePaths'];
  };
  return {
    version: 2,
    repository: map.repository,
    files: map.files,
    symbols: map.symbols,
    artifacts: map.artifacts,
    eventChannels: map.eventChannels,
    registryKeys: map.registryKeys ?? {},
    metadataKeys: map.metadataKeys ?? {},
    resources: map.resources ?? {},
    statePaths: map.statePaths ?? {},
    unresolved: map.unresolved,
    relationships: canonicalRelationships(map.relationships),
  };
}

/**
 * Read a version 3 map. Tables added after the first version 2 maps (packages, registry keys,
 * metadata keys, resources and state paths) read as empty when missing.
 */
function readV3(obj: Record<string, unknown>): ConnectionMap {
  const map = obj as unknown as Omit<
    ConnectionMap,
    'packages' | 'registryKeys' | 'metadataKeys' | 'resources' | 'statePaths'
  > & {
    packages?: ConnectionMap['packages'];
    registryKeys?: ConnectionMap['registryKeys'];
    metadataKeys?: ConnectionMap['metadataKeys'];
    resources?: ConnectionMap['resources'];
    statePaths?: ConnectionMap['statePaths'];
  };
  return {
    version: 3,
    repository: map.repository,
    packages: map.packages ?? {},
    files: map.files,
    symbols: map.symbols,
    artifacts: map.artifacts,
    eventChannels: map.eventChannels,
    registryKeys: map.registryKeys ?? {},
    metadataKeys: map.metadataKeys ?? {},
    resources: map.resources ?? {},
    statePaths: map.statePaths ?? {},
    unresolved: map.unresolved,
    relationships: canonicalRelationships(map.relationships),
  };
}

/**
 * Upgrade a version 1 map to version 2. Every v1 node is valid in v2 unchanged and the new
 * virtual-node tables start empty. Stored reverse links (`importedBy`, `calledBy`, ...) are turned
 * into the forward relationship they repeat, so the result holds each fact once.
 */
export function convertV1ToV2(map: ConnectionMapV1): ConnectionMapV2 {
  return {
    version: 2,
    repository: map.repository,
    files: map.files,
    symbols: map.symbols,
    artifacts: map.artifacts,
    eventChannels: {},
    registryKeys: {},
    metadataKeys: {},
    resources: {},
    statePaths: {},
    unresolved: {},
    relationships: canonicalRelationships(map.relationships),
  };
}

/**
 * Upgrade a version 2 map to version 3. `packages` starts empty. A manifest stored as a data
 * artifact (`package.json`, `Cargo.toml`, `pyproject.toml`, ...) becomes a file node tagged with its
 * ecosystem. Its artifact entry is kept only when a relationship still names it, so the edge that
 * code reads of the manifest keeps its target. Everything else is unchanged.
 */
export function convertV2ToV3(map: ConnectionMapV2): ConnectionMap {
  const referenced = new Set(map.relationships.flatMap((rel) => [rel.from, rel.to]));
  const files: Record<string, FileNode> = { ...map.files };
  const artifacts: Record<string, ArtifactNode> = {};

  for (const [path, artifact] of Object.entries(map.artifacts)) {
    const kind = detectManifestKind(path);
    if (!kind) {
      artifacts[path] = artifact;
      continue;
    }
    files[path] ??= { kind: 'file', path, language: kind };
    if (referenced.has(path)) artifacts[path] = artifact;
  }

  return {
    version: 3,
    repository: map.repository,
    packages: {},
    files: sortByKey(files),
    symbols: map.symbols,
    artifacts: sortByKey(artifacts),
    eventChannels: map.eventChannels,
    registryKeys: map.registryKeys,
    metadataKeys: map.metadataKeys,
    resources: map.resources,
    statePaths: map.statePaths,
    unresolved: map.unresolved,
    relationships: canonicalRelationships(map.relationships),
  };
}

function sortByKey<T>(record: Record<string, T>): Record<string, T> {
  const entries = Object.entries(record).sort(([a], [b]) => compareStrings(a, b));
  return Object.fromEntries(entries);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
