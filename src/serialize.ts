import { canonicalRelationships } from './relationship-types.js';
import type { ConnectionMap, ConnectionMapV1 } from './types.js';

/**
 * Serialize a ConnectionMap to a deterministic JSON string.
 * Uses 2-space indentation for readability.
 */
export function serializeConnectionMap(map: ConnectionMap): string {
  return JSON.stringify(map, null, 2) + '\n';
}

/**
 * Deserialize a JSON string to a ConnectionMap.
 * Performs basic structural validation.
 *
 * Version 1 maps are accepted and converted to version 2 (see {@link convertV1ToV2}); any
 * other version is rejected. Relationships are returned in canonical form for either version:
 * reverse links turned around, repeated facts merged, sorted.
 */
export function deserializeConnectionMap(json: string): ConnectionMap {
  const parsed: unknown = JSON.parse(json);

  if (!isObject(parsed)) {
    throw new Error('Invalid connection map: expected an object');
  }

  const obj = parsed as Record<string, unknown>;
  const version = obj['version'];

  if (version !== 1 && version !== 2) {
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

  if (version === 2) {
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

  if (!Array.isArray(obj['relationships'])) {
    throw new Error('Invalid connection map: missing relationships');
  }

  if (version === 1) return convertV1ToV2(parsed as unknown as ConnectionMapV1);

  // A version 2 map written before registry keys, metadata keys, resources or state paths existed
  // lacks those tables; each reads as empty. Keys are written in the same order `build` uses.
  const map = parsed as unknown as Omit<
    ConnectionMap,
    'registryKeys' | 'metadataKeys' | 'resources' | 'statePaths'
  > & {
    registryKeys?: ConnectionMap['registryKeys'];
    metadataKeys?: ConnectionMap['metadataKeys'];
    resources?: ConnectionMap['resources'];
    statePaths?: ConnectionMap['statePaths'];
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
 * Upgrade a version 1 map. Every v1 node is valid in v2 unchanged and the new virtual-node tables
 * start empty. Stored reverse links (`importedBy`, `calledBy`, ...) are turned into the forward
 * relationship they repeat, so the result holds each fact once. Key order matches
 * `ConnectionGraph.build` so a converted map serializes the same way as a freshly built one.
 */
export function convertV1ToV2(map: ConnectionMapV1): ConnectionMap {
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
