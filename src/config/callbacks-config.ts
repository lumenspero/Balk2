import type { CallbackProtocol } from '../analyzer/callback-protocols.js';
import type { ConfigProblem } from './config-problem.js';
import { IDENTIFIER_PATTERN, isArgIndex, isRecord, MAX_ARG_INDEX } from './protocol-fields.js';

const BASE = 'protocols.callbacks';
const CALLBACK_KEYS = new Set(['function', 'callbackArg']);

/**
 * Validate `protocols.callbacks`. A list with no built-ins, so nothing is linked unless the
 * project configures it. An entry with a missing or invalid `callbackArg` is rejected whole, since
 * a wrong position would link the wrong argument. Duplicates keep the first entry.
 */
export function normalizeCallbacks(
  value: unknown,
  problems: ConfigProblem[],
): CallbackProtocol[] | undefined {
  if (!Array.isArray(value)) {
    problems.push({ path: BASE, message: 'must be an array' });
    return undefined;
  }

  const callbacks: CallbackProtocol[] = [];
  const seen = new Set<string>();
  value.forEach((entry: unknown, index) => {
    const path = `${BASE}[${index}]`;
    const callback = normalizeCallback(entry, path, problems);
    if (!callback) return;

    if (seen.has(callback.function)) {
      problems.push({ path, message: `duplicate callback "${callback.function}" ignored` });
      return;
    }
    seen.add(callback.function);
    callbacks.push(callback);
  });

  return callbacks.length > 0 ? callbacks : undefined;
}

function normalizeCallback(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): CallbackProtocol | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!CALLBACK_KEYS.has(key)) {
      problems.push({ path: `${path}.${key}`, message: 'unknown key ignored' });
    }
  }

  const fn = value['function'];
  if (typeof fn !== 'string' || !IDENTIFIER_PATTERN.test(fn)) {
    problems.push({ path: `${path}.function`, message: 'must be a function name; entry ignored' });
    return undefined;
  }

  const callbackArg = value['callbackArg'];
  if (!isArgIndex(callbackArg)) {
    problems.push({
      path: `${path}.callbackArg`,
      message: `must be an integer from 0 to ${MAX_ARG_INDEX}; entry ignored`,
    });
    return undefined;
  }

  return { function: fn, callbackArg };
}
