import { scopeEntry, withLanguages } from './protocol-scope.js';
import type { MetadataProtocol } from '../analyzer/metadata-protocols.js';
import type { ConfigProblem } from './config-problem.js';
import { isRecord } from './protocol-fields.js';

const BASE = 'protocols.metadata';
const METADATA_KEYS = new Set(['key', 'defines', 'reads', 'languages']);

/**
 * Validate `protocols.metadata`. Nothing is matched unless listed here. An entry with no key, or
 * with neither `defines` nor `reads` set to true, is rejected: it would describe nothing.
 * Duplicate keys keep the first entry.
 */
export function normalizeMetadata(
  value: unknown,
  problems: ConfigProblem[],
): MetadataProtocol[] | undefined {
  if (!Array.isArray(value)) {
    problems.push({ path: BASE, message: 'must be an array' });
    return undefined;
  }

  const protocols: MetadataProtocol[] = [];
  const seen = new Set<string>();
  value.forEach((entry: unknown, index) => {
    const path = `${BASE}[${index}]`;
    const protocol = normalizeMetadataEntry(entry, path, problems);
    if (!protocol) return;
    const scope = scopeEntry(entry, path, 'metadata', problems);
    if (!scope) return;

    if (seen.has(protocol.key)) {
      problems.push({ path, message: `duplicate metadata key "${protocol.key}" ignored` });
      return;
    }
    seen.add(protocol.key);
    protocols.push(withLanguages(protocol, scope));
  });

  return protocols.length > 0 ? protocols : undefined;
}

function normalizeMetadataEntry(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): MetadataProtocol | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!METADATA_KEYS.has(key)) {
      problems.push({ path: `${path}.${key}`, message: 'unknown key ignored' });
    }
  }

  const key = value['key'];
  if (typeof key !== 'string' || key.length === 0) {
    problems.push({ path: `${path}.key`, message: 'must be a non-empty string; entry ignored' });
    return undefined;
  }

  const defines = value['defines'];
  const reads = value['reads'];
  if (defines !== undefined && typeof defines !== 'boolean') {
    problems.push({ path: `${path}.defines`, message: 'must be true or false; entry ignored' });
    return undefined;
  }
  if (reads !== undefined && typeof reads !== 'boolean') {
    problems.push({ path: `${path}.reads`, message: 'must be true or false; entry ignored' });
    return undefined;
  }
  if (defines !== true && reads !== true) {
    problems.push({
      path,
      message: 'must set defines or reads to true; entry ignored',
    });
    return undefined;
  }

  return {
    key,
    ...(defines === true ? { defines: true } : {}),
    ...(reads === true ? { reads: true } : {}),
  };
}
