import {
  BUILT_IN_REGISTRY_PROTOCOLS,
  type RegistryDecoratorRule,
  type RegistryDirection,
  type RegistryDiscoverRule,
  type RegistryManifestEntry,
  type RegistryNameInjectionRule,
  type RegistryProtocol,
  type RegistryProtocolOptions,
  type RegistryRule,
} from '../analyzer/registry-protocols.js';
import type { ConfigProblem } from './config-problem.js';
import {
  argField,
  dropped,
  IDENTIFIER_PATTERN,
  isArgIndex,
  isRecord,
  MAX_ARG_INDEX,
  stringList,
} from './protocol-fields.js';

/** Registry conventions for a repository; see `protocols.registries` in `.balk2.json`. */
export type RegistryProtocolsConfig = RegistryProtocolOptions;

const REGISTRY_KEYS = new Set([
  'builtIns',
  'disable',
  'methods',
  'decorators',
  'parameterDecorators',
  'nameInjection',
  'manifest',
  'discover',
]);
const DECORATOR_KEYS = new Set(['name', 'registry', 'keyArg']);
const NAME_INJECTION_KEYS = new Set(['registry', 'decorator']);
const MANIFEST_KEYS = new Set(['registry', 'key', 'target']);
const DISCOVER_KEYS = new Set(['glob', 'registry']);
const METHOD_KEYS = new Set(['method', 'direction', 'keyArg', 'keyFrom', 'valueArg', 'receiver']);
const DIRECTIONS: readonly RegistryDirection[] = ['register', 'resolve', 'route'];
const KEY_FROM_VALUES = ['typeArgument'] as const;
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
  const decorators = normalizeEntries(
    value['decorators'],
    'decorators' in value,
    `${base}.decorators`,
    problems,
    normalizeDecorator,
  );
  const parameterDecorators = normalizeEntries(
    value['parameterDecorators'],
    'parameterDecorators' in value,
    `${base}.parameterDecorators`,
    problems,
    normalizeDecorator,
  );
  const nameInjection = normalizeEntries(
    value['nameInjection'],
    'nameInjection' in value,
    `${base}.nameInjection`,
    problems,
    normalizeNameInjection,
  );
  const manifest = normalizeEntries(
    value['manifest'],
    'manifest' in value,
    `${base}.manifest`,
    problems,
    normalizeManifestEntry,
  );
  const discover = normalizeEntries(
    value['discover'],
    'discover' in value,
    `${base}.discover`,
    problems,
    normalizeDiscover,
  );

  const result: RegistryProtocolsConfig = {
    ...(builtIns !== undefined ? { builtIns } : {}),
    ...(disable.length > 0 ? { disable } : {}),
    ...(methods.length > 0 ? { methods } : {}),
    ...(decorators.length > 0 ? { decorators } : {}),
    ...(parameterDecorators.length > 0 ? { parameterDecorators } : {}),
    ...(nameInjection.length > 0 ? { nameInjection } : {}),
    ...(manifest.length > 0 ? { manifest } : {}),
    ...(discover.length > 0 ? { discover } : {}),
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

  // `keyFrom` changes which argument or type is the key, so an unknown value rejects the entry
  // rather than falling back to `keyArg`, which would match the wrong thing.
  let keyFrom: (typeof KEY_FROM_VALUES)[number] | undefined;
  if ('keyFrom' in value) {
    const raw = value['keyFrom'];
    if (!KEY_FROM_VALUES.some((allowed) => allowed === raw)) {
      problems.push({
        path: `${path}.keyFrom`,
        message: `must be one of ${KEY_FROM_VALUES.join(', ')}; entry ignored`,
      });
      return undefined;
    }
    keyFrom = raw as (typeof KEY_FROM_VALUES)[number];
  }

  let keyArg: number | undefined;
  if (keyFrom !== undefined) {
    if ('keyArg' in value) {
      dropped(`${path}.keyArg`, 'not used when keyFrom is set', problems);
    }
  } else {
    const raw = value['keyArg'];
    if (!isArgIndex(raw)) {
      problems.push({
        path: `${path}.keyArg`,
        message: `must be an integer from 0 to ${MAX_ARG_INDEX}; entry ignored`,
      });
      return undefined;
    }
    keyArg = raw;
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
  if (valueArg !== undefined && keyArg !== undefined && valueArg === keyArg) {
    problems.push({
      path: `${path}.valueArg`,
      message: `must differ from keyArg (both are ${keyArg}); entry ignored`,
    });
    return undefined;
  }

  return {
    method,
    direction,
    ...(keyArg !== undefined ? { keyArg } : {}),
    ...(keyFrom !== undefined ? { keyFrom } : {}),
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

/**
 * A list of entries, each checked by `normalize`. A missing or malformed list is reported and
 * treated as empty; a malformed entry is reported and dropped.
 */
function normalizeEntries<T>(
  value: unknown,
  present: boolean,
  path: string,
  problems: ConfigProblem[],
  normalize: (entry: unknown, path: string, problems: ConfigProblem[]) => T | undefined,
): T[] {
  if (!present) return [];
  if (!Array.isArray(value)) {
    problems.push({ path, message: 'must be an array' });
    return [];
  }

  const entries: T[] = [];
  value.forEach((entry: unknown, index) => {
    const normalized = normalize(entry, `${path}[${index}]`, problems);
    if (normalized !== undefined) entries.push(normalized);
  });
  return entries;
}

function normalizeNameInjection(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): RegistryNameInjectionRule | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }
  reportUnknownKeys(value, NAME_INJECTION_KEYS, path, problems);
  const registry = nonEmptyString(value['registry'], `${path}.registry`, problems);
  const decorator = nonEmptyString(value['decorator'], `${path}.decorator`, problems);
  if (registry === undefined || decorator === undefined) return undefined;
  return { registry, decorator };
}

function normalizeDecorator(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): RegistryDecoratorRule | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }
  reportUnknownKeys(value, DECORATOR_KEYS, path, problems);

  const name = value['name'];
  if (typeof name !== 'string' || !IDENTIFIER_PATTERN.test(name)) {
    problems.push({ path: `${path}.name`, message: 'must be an identifier; entry ignored' });
    return undefined;
  }
  const registry = nonEmptyString(value['registry'], `${path}.registry`, problems);
  if (registry === undefined) return undefined;

  const keyArg = argField(value, 'keyArg', true, '', path, problems);
  return { name, registry, ...(keyArg !== undefined ? { keyArg } : {}) };
}

function normalizeManifestEntry(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): RegistryManifestEntry | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }
  reportUnknownKeys(value, MANIFEST_KEYS, path, problems);

  const registry = nonEmptyString(value['registry'], `${path}.registry`, problems);
  const key = nonEmptyString(value['key'], `${path}.key`, problems);
  const target = nonEmptyString(value['target'], `${path}.target`, problems);
  if (registry === undefined || key === undefined || target === undefined) return undefined;
  return { registry, key, target };
}

function normalizeDiscover(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): RegistryDiscoverRule | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }
  reportUnknownKeys(value, DISCOVER_KEYS, path, problems);

  const glob = nonEmptyString(value['glob'], `${path}.glob`, problems);
  const registry = nonEmptyString(value['registry'], `${path}.registry`, problems);
  if (glob === undefined || registry === undefined) return undefined;
  // A glob is relative to the repository. An absolute one would match nothing, so reject it.
  if (glob.startsWith('/')) {
    problems.push({
      path: `${path}.glob`,
      message: 'must be relative to the repository; entry ignored',
    });
    return undefined;
  }
  return { glob, registry };
}

function nonEmptyString(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  problems.push({ path, message: 'must be a non-empty string; entry ignored' });
  return undefined;
}

function reportUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  problems: ConfigProblem[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      problems.push({ path: `${path}.${key}`, message: 'unknown key ignored' });
  }
}
