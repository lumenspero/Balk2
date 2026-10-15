import {
  BUILT_IN_STATE_PROTOCOLS,
  type StateAccess,
  type StateProtocol,
} from '../analyzer/state-protocols.js';
import type { ConfigProblem } from './config-problem.js';
import { IDENTIFIER_PATTERN, isArgIndex, isRecord, MAX_ARG_INDEX } from './protocol-fields.js';

/** A module export that holds shared state, e.g. `{ "module": "src/store.ts", "export": "store" }`. */
export interface StateSingleton {
  /** Repository-relative path of the module that declares the export */
  readonly module: string;
  /** Export name, or `default` */
  readonly export: string;
}

/** How a computed property whose name is not statically known is recorded. */
export type DynamicPathMode = 'off' | 'wildcard';

/** The `state` section of `.balk2.json`: what counts as shared state and how it is accessed. */
export interface StateConfig {
  /**
   * Free identifiers that denote a shared state object, such as a value injected by a bundler
   * (`__APP_STATE__`). A local or module binding with the same name is not the root.
   */
  readonly roots?: readonly string[];
  /**
   * State under the global object. `true` (the default) tracks global properties the repository
   * assigns somewhere; a list tracks only those top-level names; `false` tracks none.
   */
  readonly globals?: boolean | readonly string[];
  /** Module exports that hold shared state */
  readonly singletons?: readonly StateSingleton[];
  /** Whether the built-in state methods apply; default true */
  readonly builtIns?: boolean;
  /** Built-in methods to turn off */
  readonly disable?: readonly string[];
  /** Project-specific state methods; a method named like a built-in replaces it */
  readonly methods?: readonly StateProtocol[];
  /**
   * `off` (the default) reports a computed property as an unresolved `dynamic-state-path`
   * observation; `wildcard` records it as a `[*]` path segment.
   */
  readonly dynamicPaths?: DynamicPathMode;
}

export interface NormalizedStateConfig {
  readonly config?: StateConfig;
  readonly problems: readonly ConfigProblem[];
}

const BASE = 'state';
const STATE_KEYS = new Set([
  'roots',
  'globals',
  'singletons',
  'builtIns',
  'disable',
  'methods',
  'dynamicPaths',
]);
const SINGLETON_KEYS = new Set(['module', 'export']);
const METHOD_KEYS = new Set(['method', 'access', 'keyArg', 'pathSeparator']);
const ACCESSES: readonly StateAccess[] = ['read', 'write', 'delete', 'update'];
const DYNAMIC_PATH_MODES: readonly DynamicPathMode[] = ['off', 'wildcard'];
const BUILT_IN_METHODS = new Set(BUILT_IN_STATE_PROTOCOLS.map((protocol) => protocol.method));

/**
 * Validate the `state` section. Anything unusable is dropped and reported. As in the protocol
 * sections, a mistake that would widen what counts as state rejects the whole entry; a mistake in
 * a descriptive field drops only that field.
 */
export function normalizeStateConfig(value: unknown): NormalizedStateConfig {
  const problems: ConfigProblem[] = [];

  if (!isRecord(value)) {
    problems.push({ path: BASE, message: 'must be an object' });
    return { problems };
  }

  for (const key of Object.keys(value)) {
    if (!STATE_KEYS.has(key)) {
      problems.push({ path: `${BASE}.${key}`, message: 'unknown key ignored' });
    }
  }

  const roots = identifierList(value, 'roots', problems);
  const globals = normalizeGlobals(value, problems);
  const singletons = normalizeSingletons(value, problems);
  const builtIns = booleanField(value, 'builtIns', problems);
  const disable = normalizeDisable(value, problems);
  const methods = normalizeMethods(value, problems);
  const dynamicPaths = normalizeDynamicPaths(value, problems);

  const config: StateConfig = {
    ...(roots && roots.length > 0 ? { roots } : {}),
    ...(globals !== undefined ? { globals } : {}),
    ...(singletons.length > 0 ? { singletons } : {}),
    ...(builtIns !== undefined ? { builtIns } : {}),
    ...(disable.length > 0 ? { disable } : {}),
    ...(methods.length > 0 ? { methods } : {}),
    ...(dynamicPaths !== undefined ? { dynamicPaths } : {}),
  };
  return { ...(Object.keys(config).length > 0 ? { config } : {}), problems };
}

/** Distinct identifiers from a list field; `undefined` when absent or when nothing is usable. */
function identifierList(
  value: Record<string, unknown>,
  key: string,
  problems: ConfigProblem[],
): string[] | undefined {
  if (!(key in value)) return undefined;
  const list = value[key];
  const at = `${BASE}.${key}`;
  if (!Array.isArray(list)) {
    problems.push({ path: at, message: 'must be an array of identifiers' });
    return undefined;
  }

  const valid: string[] = [];
  list.forEach((entry: unknown, index) => {
    if (typeof entry !== 'string' || !IDENTIFIER_PATTERN.test(entry)) {
      problems.push({ path: `${at}[${index}]`, message: 'must be an identifier' });
    } else if (!valid.includes(entry)) {
      valid.push(entry);
    }
  });
  return valid;
}

function normalizeGlobals(
  value: Record<string, unknown>,
  problems: ConfigProblem[],
): boolean | string[] | undefined {
  if (!('globals' in value)) return undefined;
  const globals = value['globals'];
  if (typeof globals === 'boolean') return globals;

  if (!Array.isArray(globals)) {
    problems.push({
      path: `${BASE}.globals`,
      message: 'must be true, false, or an array of property names',
    });
    return undefined;
  }

  const names = identifierList(value, 'globals', problems) ?? [];
  if (globals.length > 0 && names.length === 0) {
    // An all-invalid list must not silently turn global state tracking off.
    problems.push({
      path: `${BASE}.globals`,
      message: 'has no valid names; the default is kept',
    });
    return undefined;
  }
  return names;
}

function normalizeSingletons(
  value: Record<string, unknown>,
  problems: ConfigProblem[],
): StateSingleton[] {
  if (!('singletons' in value)) return [];
  const list = value['singletons'];
  const at = `${BASE}.singletons`;
  if (!Array.isArray(list)) {
    problems.push({ path: at, message: 'must be an array' });
    return [];
  }

  const singletons: StateSingleton[] = [];
  const firstIndexOf = new Map<string, number>();
  list.forEach((entry: unknown, index) => {
    const path = `${at}[${index}]`;
    const singleton = normalizeSingleton(entry, path, problems);
    if (!singleton) return;

    const id = `${singleton.module}:${singleton.export}`;
    const first = firstIndexOf.get(id);
    if (first !== undefined) {
      problems.push({
        path,
        message: `duplicate singleton "${id}" ignored; first defined at singletons[${first}]`,
      });
      return;
    }
    firstIndexOf.set(id, index);
    singletons.push(singleton);
  });
  return singletons;
}

function normalizeSingleton(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): StateSingleton | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }
  reportUnknownKeys(value, SINGLETON_KEYS, path, problems);

  const rawModule = value['module'];
  if (typeof rawModule !== 'string' || rawModule.length === 0) {
    problems.push({ path: `${path}.module`, message: 'must be a non-empty path; entry ignored' });
    return undefined;
  }
  const module = rawModule.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
  // A module path is relative to the repository. An absolute one would match nothing.
  if (module.startsWith('/') || /^[A-Za-z]:\//.test(module)) {
    problems.push({
      path: `${path}.module`,
      message: 'must be relative to the repository; entry ignored',
    });
    return undefined;
  }

  const exported = value['export'];
  if (typeof exported !== 'string' || !IDENTIFIER_PATTERN.test(exported)) {
    problems.push({
      path: `${path}.export`,
      message: 'must be an export name or "default"; entry ignored',
    });
    return undefined;
  }

  return { module, export: exported };
}

function booleanField(
  value: Record<string, unknown>,
  key: string,
  problems: ConfigProblem[],
): boolean | undefined {
  if (!(key in value)) return undefined;
  if (typeof value[key] === 'boolean') return value[key];
  problems.push({ path: `${BASE}.${key}`, message: 'must be true or false' });
  return undefined;
}

function normalizeDisable(value: Record<string, unknown>, problems: ConfigProblem[]): string[] {
  if (!('disable' in value)) return [];
  const list = value['disable'];
  if (!Array.isArray(list)) {
    problems.push({ path: `${BASE}.disable`, message: 'must be an array of method names' });
    return [];
  }

  const disabled: string[] = [];
  list.forEach((entry: unknown, index) => {
    const path = `${BASE}.disable[${index}]`;
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
  value: Record<string, unknown>,
  problems: ConfigProblem[],
): StateProtocol[] {
  if (!('methods' in value)) return [];
  const list = value['methods'];
  if (!Array.isArray(list)) {
    problems.push({ path: `${BASE}.methods`, message: 'must be an array' });
    return [];
  }

  const protocols: StateProtocol[] = [];
  const firstIndexOf = new Map<string, number>();
  list.forEach((entry: unknown, index) => {
    const path = `${BASE}.methods[${index}]`;
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
): StateProtocol | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }
  reportUnknownKeys(value, METHOD_KEYS, path, problems);

  const method = value['method'];
  if (typeof method !== 'string' || !IDENTIFIER_PATTERN.test(method)) {
    problems.push({ path: `${path}.method`, message: 'must be a method name; entry ignored' });
    return undefined;
  }

  const access = value['access'];
  if (!isAccess(access)) {
    problems.push({
      path: `${path}.access`,
      message: `must be one of ${ACCESSES.join(', ')}; entry ignored`,
    });
    return undefined;
  }

  // A malformed key position would turn a keyed access into a whole-container access, which
  // widens what the call touches; reject the entry instead of guessing.
  let keyArg: number | undefined;
  if ('keyArg' in value) {
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

  let pathSeparator: string | undefined;
  if ('pathSeparator' in value) {
    const separator = value['pathSeparator'];
    if (typeof separator !== 'string' || separator.length === 0) {
      problems.push({
        path: `${path}.pathSeparator`,
        message: 'must be a non-empty string; field ignored',
      });
    } else if (keyArg === undefined) {
      problems.push({
        path: `${path}.pathSeparator`,
        message: 'only applies with keyArg; field ignored',
      });
    } else {
      pathSeparator = separator;
    }
  }

  return {
    method,
    access,
    ...(keyArg !== undefined ? { keyArg } : {}),
    ...(pathSeparator !== undefined ? { pathSeparator } : {}),
  };
}

function normalizeDynamicPaths(
  value: Record<string, unknown>,
  problems: ConfigProblem[],
): DynamicPathMode | undefined {
  if (!('dynamicPaths' in value)) return undefined;
  const mode = DYNAMIC_PATH_MODES.find((candidate) => candidate === value['dynamicPaths']);
  if (mode === undefined) {
    problems.push({
      path: `${BASE}.dynamicPaths`,
      message: `must be one of ${DYNAMIC_PATH_MODES.join(', ')}; the default "off" is kept`,
    });
  }
  return mode;
}

function isAccess(value: unknown): value is StateAccess {
  return ACCESSES.some((access) => access === value);
}

function reportUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  problems: ConfigProblem[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      problems.push({ path: `${path}.${key}`, message: 'unknown key ignored' });
    }
  }
}
