import type { ReceiverRule } from '../analyzer/event-protocols.js';
import type { LoaderProtocol } from '../analyzer/loader-protocols.js';
import type { ConfigProblem } from './config-problem.js';
import {
  IDENTIFIER_PATTERN,
  isArgIndex,
  isRecord,
  MAX_ARG_INDEX,
  stringList,
} from './protocol-fields.js';

const BASE = 'protocols.loaders';
const LOADER_KEYS = new Set(['function', 'specifierArg', 'receiver']);

/**
 * Validate `protocols.loaders`. Loaders are a list with no built-ins, so nothing matches unless the
 * project configures it.
 *
 * An entry with a missing or invalid `specifierArg`, or an unusable `receiver`, is rejected whole.
 * A wrong position could make a loader read the wrong argument, and an invalid receiver must not
 * widen to every call. Duplicates keep the first entry.
 */
export function normalizeLoaders(
  value: unknown,
  problems: ConfigProblem[],
): LoaderProtocol[] | undefined {
  if (!Array.isArray(value)) {
    problems.push({ path: BASE, message: 'must be an array' });
    return undefined;
  }

  const loaders: LoaderProtocol[] = [];
  const seen = new Set<string>();
  value.forEach((entry: unknown, index) => {
    const path = `${BASE}[${index}]`;
    const loader = normalizeLoader(entry, path, problems);
    if (!loader) return;

    const id = loaderId(loader);
    if (seen.has(id)) {
      problems.push({ path, message: `duplicate loader "${loader.function}" ignored` });
      return;
    }
    seen.add(id);
    loaders.push(loader);
  });

  return loaders.length > 0 ? loaders : undefined;
}

function normalizeLoader(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): LoaderProtocol | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!LOADER_KEYS.has(key)) {
      problems.push({ path: `${path}.${key}`, message: 'unknown key ignored' });
    }
  }

  const fn = value['function'];
  if (typeof fn !== 'string' || !IDENTIFIER_PATTERN.test(fn)) {
    problems.push({ path: `${path}.function`, message: 'must be a function name; entry ignored' });
    return undefined;
  }

  const specifierArg = value['specifierArg'];
  if (!isArgIndex(specifierArg)) {
    problems.push({
      path: `${path}.specifierArg`,
      message: `must be an integer from 0 to ${MAX_ARG_INDEX}; entry ignored`,
    });
    return undefined;
  }

  let receiver: ReceiverRule | undefined;
  if ('receiver' in value) {
    const parsed = normalizeLoaderReceiver(value['receiver'], `${path}.receiver`, problems);
    if (parsed === null) return undefined;
    receiver = parsed;
  }

  return {
    function: fn,
    specifierArg,
    ...(receiver ? { receiver } : {}),
  };
}

/**
 * A receiver rule for a method loader. Unlike event and registry receivers, `"any"` is not
 * accepted: a loader names a function, and "any object" would match every method of that name.
 * Returns `null` when the rule is unusable, so the whole entry is rejected.
 */
function normalizeLoaderReceiver(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): ReceiverRule | null {
  if (!isRecord(value)) {
    problems.push({
      path,
      message: 'must be an object with names and/or types; entry ignored',
    });
    return null;
  }

  for (const key of Object.keys(value)) {
    if (key !== 'names' && key !== 'types') {
      problems.push({ path: `${path}.${key}`, message: 'unknown key ignored' });
    }
  }

  const names = stringList(value['names'], 'names' in value, `${path}.names`, problems);
  const types = stringList(value['types'], 'types' in value, `${path}.types`, problems);
  if (names === null || types === null || (names.length === 0 && types.length === 0)) {
    problems.push({ path, message: 'must list at least one valid name or type; entry ignored' });
    return null;
  }

  return {
    ...(names.length > 0 ? { names } : {}),
    ...(types.length > 0 ? { types } : {}),
  };
}

/** Identity for duplicate detection: the function name plus its receiver rule, if any. */
function loaderId(loader: LoaderProtocol): string {
  return JSON.stringify([loader.function, loader.receiver ?? null]);
}