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
 * other version is rejected.
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
  }

  if (!Array.isArray(obj['relationships'])) {
    throw new Error('Invalid connection map: missing relationships');
  }

  return version === 1
    ? convertV1ToV2(parsed as unknown as ConnectionMapV1)
    : (parsed as unknown as ConnectionMap);
}

/**
 * Upgrade a version 1 map. Every v1 node and relationship is valid in v2 unchanged; the
 * new virtual-node tables start empty. Key order matches `ConnectionGraph.build` so a
 * converted map serializes the same way as a freshly built one.
 */
export function convertV1ToV2(map: ConnectionMapV1): ConnectionMap {
  return {
    version: 2,
    repository: map.repository,
    files: map.files,
    symbols: map.symbols,
    artifacts: map.artifacts,
    eventChannels: {},
    unresolved: {},
    relationships: map.relationships,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
