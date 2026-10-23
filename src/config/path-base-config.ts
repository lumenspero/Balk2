import type { PathBase } from '../facts/path-value.js';
import type { ConfigProblem } from './config-problem.js';

/**
 * `data.pathBase` (V3 Phase 11.4): the order in which a bare relative data path is placed. A list
 * gives the order for every language; an object gives it per language, and a language it does not
 * name keeps the default order.
 */
export type PathBaseLanguage = 'javascript' | 'python' | 'rust';

export type PathBaseConfig =
  readonly PathBase[] | { readonly [language in PathBaseLanguage]?: readonly PathBase[] };

const BASES: readonly string[] = ['file', 'package', 'repository', 'public'];
const LANGUAGES: readonly string[] = ['javascript', 'python', 'rust'];

function isBase(value: unknown): value is PathBase {
  return typeof value === 'string' && BASES.includes(value);
}

function validateOrder(value: unknown, path: string): ConfigProblem[] {
  if (!Array.isArray(value)) return [{ path, message: 'must be a list of bases' }];
  const problems: ConfigProblem[] = value
    .filter((base) => !isBase(base))
    .map(() => ({ path, message: 'unknown base ignored' }));
  if (!value.some(isBase)) problems.push({ path, message: 'lists no usable base' });
  return problems;
}

/** Problems with a `data.pathBase` value. Unusable entries are dropped by `normalizePathBaseConfig`. */
export function validatePathBaseConfig(value: unknown): ConfigProblem[] {
  if (Array.isArray(value)) return validateOrder(value, 'data.pathBase');
  if (typeof value !== 'object' || value === null) {
    return [
      { path: 'data.pathBase', message: 'must be a list of bases, or an object by language' },
    ];
  }
  return Object.entries(value).flatMap(([language, order]) =>
    LANGUAGES.includes(language)
      ? validateOrder(order, `data.pathBase.${language}`)
      : [{ path: `data.pathBase.${language}`, message: 'unknown language ignored' }],
  );
}

/** The usable part of a `data.pathBase` value, or undefined when none of it is usable. */
export function normalizePathBaseConfig(value: unknown): PathBaseConfig | undefined {
  if (Array.isArray(value)) {
    const bases = value.filter(isBase);
    return bases.length > 0 ? bases : undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const byLanguage: { [language in PathBaseLanguage]?: readonly PathBase[] } = {};
  for (const language of LANGUAGES as PathBaseLanguage[]) {
    const order = (value as Record<string, unknown>)[language];
    const bases = Array.isArray(order) ? order.filter(isBase) : [];
    if (bases.length > 0) byLanguage[language] = bases;
  }
  return Object.keys(byLanguage).length > 0 ? byLanguage : undefined;
}

/** The base order a language's bare paths use under the configuration, or undefined for the default. */
export function pathBaseOrder(
  config: { readonly data?: { readonly pathBase?: PathBaseConfig } } | undefined,
  language: PathBaseLanguage,
): readonly PathBase[] | undefined {
  const pathBase = config?.data?.pathBase;
  if (pathBase === undefined) return undefined;
  if (Array.isArray(pathBase)) return pathBase as readonly PathBase[];
  return (pathBase as { readonly [l in PathBaseLanguage]?: readonly PathBase[] })[language];
}
