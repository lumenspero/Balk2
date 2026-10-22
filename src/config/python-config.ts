import type { ConfigProblem } from './config-problem.js';

/** The `python` section of `.balk2.json` (V3 Phase 5.5 and 4.2). */
export interface PythonConfig {
  /**
   * Repository decorators that return their argument unchanged, as written. They add to the
   * built-in identity list, so calls to a decorated function keep their usual confidence.
   */
  readonly identityDecorators?: readonly string[];
  /**
   * Import roots, repository-relative, in precedence order (V3 Phase 4.2). When omitted, the
   * repository root is the only root.
   */
  readonly roots?: readonly string[];
}

const KEYS = ['identityDecorators', 'roots'] as const;

/** Reads a list of non-empty strings for one key, recording a problem when it is not one. */
function stringList(
  raw: Record<string, unknown>,
  key: (typeof KEYS)[number],
  problems: ConfigProblem[],
): readonly string[] | undefined {
  if (!(key in raw)) return undefined;
  const list = raw[key];
  if (Array.isArray(list) && list.every((e) => typeof e === 'string' && e.length > 0)) {
    return list as string[];
  }
  problems.push({ path: `python.${key}`, message: 'must be an array of non-empty strings' });
  return undefined;
}

/** Reads the `python` section. Returns the usable entries and records a problem for each other entry. */
export function normalizePythonConfig(
  value: unknown,
  problems: ConfigProblem[],
): PythonConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push({ path: 'python', message: 'must be an object' });
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      problems.push({ path: `python.${key}`, message: 'unknown key ignored' });
    }
  }
  const config: { identityDecorators?: readonly string[]; roots?: readonly string[] } = {};
  const identityDecorators = stringList(raw, 'identityDecorators', problems);
  if (identityDecorators) config.identityDecorators = identityDecorators;
  const roots = stringList(raw, 'roots', problems);
  if (roots) config.roots = roots;
  return config;
}
