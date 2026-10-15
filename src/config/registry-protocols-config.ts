import {
  BUILT_IN_REGISTRY_PROTOCOLS,
  type RegistryDirection,
  type RegistryProtocol,
  type RegistryProtocolOptions,
  type RegistryRule,
} from '../analyzer/registry-protocols.js';
import type { ConfigProblem } from './config-problem.js';
import {
  argField,
  IDENTIFIER_PATTERN,
  isArgIndex,
  isRecord,
  MAX_ARG_INDEX,
  stringList,
} from './protocol-fields.js';

/** Registry conventions for a repository; see `protocols.registries` in `.balk2.json`. */
export type RegistryProtocolsConfig = RegistryProtocolOptions;

const REGISTRY_KEYS = new Set(['builtIns', 'disable', 'methods']);
const METHOD_KEYS = new Set(['method', 'direction', 'keyArg', 'valueArg', 'receiver']);
const DIRECTIONS: readonly RegistryDirection[] = ['register', 'resolve', 'route'];
const BUILT_IN_METHODS = new Set(BUILT_IN_REGISTRY_PROTOCOLS.map((protocol) => protocol.method));

/**
 * Validate the `protocols.registries` section. Anything unusable is dropped and reported. A
 * mistake that would make a protocol match more than intended rejects the entry.
 */
export function normalizeRegistries(
  value: unknown,
  problems: ConfigProblem[],
): RegistryProtocolsConfig | undefined {
  const base = 'protocols.registries';
  if (!isRecord(value)) {
    problems.push({ path: base, message: 'must be an object' });
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!REGISTRY_KEYS.has(key)) {
      problems.push({ path: `${base}.${key}`, message: 'unknown key ignored' });
    }
  }

  let builtIns: boolean | undefined;
  if ('builtIns' in value) {
    if (typeof value['builtIns'] === 'boolean') {
      builtIns = value['builtIns'];
    } else {
      problems.push({ path: `${base}.builtIns`, message: 'must be true or false' });
    }
  }

  const disable = normalizeDisable(value['disable'], 'disable' in value, problems);
  const methods = normalizeMethods(value['methods'], 'methods' in value, problems);

  const result: RegistryProtocolsConfig = {
    ...(builtIns !== undefined ? { builtIns } : {}),
    ...(disable.length > 0 ? { disable } : {}),
    ...(methods.length > 0 ? { methods } : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeDisable(value: unknown, present: boolean, problems: ConfigProblem[]): string[] {
  if (!present) return [];
  if (!Array.isArray(value)) {
    problems.push({
      path: 'protocols.registries.disable',
      message: 'must be an array of method names',
    });
    return [];
  }

  const disabled: string[] = [];
  value.forEach((entry: unknown, index) => {
    const path = `protocols.registries.disable[${index}]`;
    if (typeof entry !== 'string' || !IDENTIFIER_PATTERN.test(entry)) {
      problems.push({ path, message: 'must be a method name' });
    } else if (!BUILT_IN_METHODS.has(entry)) {
      problems.push({ path, message: `"${entry}" is not a built-in method; nothing to disable` });
    } else if (!disabled.includes(entry)) {
      disabled.push(entry);
    }
  });
  return disabled;
}

function normalizeMethods(
  value: unknown,
  present: boolean,
  problems: ConfigProblem[],
): RegistryProtocol[] {
  if (!present) return [];
  if (!Array.isArray(value)) {
    problems.push({ path: 'protocols.registries.methods', message: 'must be an array' });
    return [];
  }

  const protocols: RegistryProtocol[] = [];
  const firstIndexOf = new Map<string, number>();
  value.forEach((entry: unknown, index) => {
    const path = `protocols.registries.methods[${index}]`;
    const protocol = normalizeMethod(entry, path, problems);
    if (!protocol) return;

    const first = firstIndexOf.get(protocol.method);
    if (first !== undefined) {
      problems.push({
        path: `${path}.method`,
        message: `duplicate method "${protocol.method}" ignored; first defined at methods[${first}]`,
      });
      return;
    }
    firstIndexOf.set(protocol.method, index);
    protocols.push(protocol);
  });
  return protocols;
}

function normalizeMethod(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): RegistryProtocol | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!METHOD_KEYS.has(key)) {
      problems.push({ path: `${path}.${key}`, message: 'unknown key ignored' });
    }
  }

  const method = value['method'];
  if (typeof method !== 'string' || !IDENTIFIER_PATTERN.test(method)) {
    problems.push({ path: `${path}.method`, message: 'must be a method name; entry ignored' });
    return undefined;
  }

  const direction = value['direction'];
  if (!isDirection(direction)) {
    problems.push({
      path: `${path}.direction`,
      message: `must be one of ${DIRECTIONS.join(', ')}; entry ignored`,
    });
    return undefined;
  }

  const keyArg = value['keyArg'];
  if (!isArgIndex(keyArg)) {
    problems.push({
      path: `${path}.keyArg`,
      message: `must be an integer from 0 to ${MAX_ARG_INDEX}; entry ignored`,
    });
    return undefined;
  }

  const receiver = normalizeReceiver(value, path, problems);
  if (receiver === null) return undefined;

  const valueArg = argField(
    value,
    'valueArg',
    direction === 'register',
    'register',
    path,
    problems,
  );
  if (valueArg !== undefined && valueArg === keyArg) {
    problems.push({
      path: `${path}.valueArg`,
      message: `must differ from keyArg (both are ${keyArg}); entry ignored`,
    });
    return undefined;
  }

  return {
    method,
    direction,
    keyArg,
    ...(valueArg !== undefined ? { valueArg } : {}),
    ...(receiver ? { receiver } : {}),
  };
}

/**
 * `undefined` when no receiver rule is given, a rule when valid, and `null` when the rule is
 * unusable (the entry is rejected rather than widened to every receiver).
 */
function normalizeReceiver(
  entry: Record<string, unknown>,
  path: string,
  problems: ConfigProblem[],
): RegistryRule | undefined | null {
  if (!('receiver' in entry)) return undefined;
  const receiver = entry['receiver'];
  const at = `${path}.receiver`;

  if (receiver === 'any' || receiver === 'registry-like') return receiver;

  if (!isRecord(receiver)) {
    problems.push({
      path: at,
      message:
        'must be "registry-like", "any", or an object with names and/or types; entry ignored',
    });
    return null;
  }

  for (const key of Object.keys(receiver)) {
    if (key !== 'names' && key !== 'types') {
      problems.push({ path: `${at}.${key}`, message: 'unknown key ignored' });
    }
  }

  const names = stringList(receiver['names'], 'names' in receiver, `${at}.names`, problems);
  const types = stringList(receiver['types'], 'types' in receiver, `${at}.types`, problems);
  if (names === null || types === null || (names.length === 0 && types.length === 0)) {
    problems.push({
      path: at,
      message: 'must list at least one valid name or type; entry ignored',
    });
    return null;
  }

  return { ...(names.length > 0 ? { names } : {}), ...(types.length > 0 ? { types } : {}) };
}

function isDirection(value: unknown): value is RegistryDirection {
  return DIRECTIONS.some((direction) => direction === value);
}
