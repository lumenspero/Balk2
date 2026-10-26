import { scopeEntry, withLanguages } from './protocol-scope.js';
import type { ResourceProtocol } from '../analyzer/resource-protocols.js';
import type { ConfigProblem } from './config-problem.js';
import { IDENTIFIER_PATTERN, isArgIndex, isRecord, MAX_ARG_INDEX } from './protocol-fields.js';

const BASE = 'protocols.resources';
const RESOURCE_KEYS = new Set(['function', 'specifierArg', 'languages']);

/**
 * Validate `protocols.resources`. A list with no built-ins, so nothing is linked unless the project
 * configures it. An entry with a missing or invalid `specifierArg` is rejected whole, since a wrong
 * position would read the wrong argument. Duplicate functions keep the first entry.
 */
export function normalizeResources(
  value: unknown,
  problems: ConfigProblem[],
): ResourceProtocol[] | undefined {
  if (!Array.isArray(value)) {
    problems.push({ path: BASE, message: 'must be an array' });
    return undefined;
  }

  const resources: ResourceProtocol[] = [];
  const seen = new Set<string>();
  value.forEach((entry: unknown, index) => {
    const path = `${BASE}[${index}]`;
    const resource = normalizeResource(entry, path, problems);
    if (!resource) return;
    const scope = scopeEntry(entry, path, 'resources', problems);
    if (!scope) return;

    if (seen.has(resource.function)) {
      problems.push({ path, message: `duplicate resource loader "${resource.function}" ignored` });
      return;
    }
    seen.add(resource.function);
    resources.push(withLanguages(resource, scope));
  });

  return resources.length > 0 ? resources : undefined;
}

function normalizeResource(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): ResourceProtocol | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!RESOURCE_KEYS.has(key)) {
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

  return { function: fn, specifierArg };
}
