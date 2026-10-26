import type { FrontEndLanguage } from '../analyzer/front-end.js';
import type { ConfigProblem } from './config-problem.js';
import { isRecord } from './protocol-fields.js';

/**
 * Languages a protocol entry can be tagged with (V3 Phase 15.3). `javascript` and `typescript` name
 * one family: both files go through the same JS/TS front end, so either tag selects that front end.
 */
export const FRONT_END_LANGUAGES: readonly FrontEndLanguage[] = [
  'javascript',
  'typescript',
  'python',
  'rust',
];

export const JS_TS_LANGUAGES: readonly FrontEndLanguage[] = ['javascript', 'typescript'];
export const PYTHON_LANGUAGES: readonly FrontEndLanguage[] = ['python'];
export const RUST_LANGUAGES: readonly FrontEndLanguage[] = ['rust'];

/**
 * The languages whose front end reads each protocol list today. An entry tagged with a language
 * outside its list is reported and ignored for that language, rather than silently doing nothing.
 */
const CONSUMERS = {
  'events.methods': JS_TS_LANGUAGES,
  callbacks: JS_TS_LANGUAGES,
  loaders: JS_TS_LANGUAGES,
  metadata: JS_TS_LANGUAGES,
  resources: [...JS_TS_LANGUAGES, ...PYTHON_LANGUAGES],
  'registries.methods': [...JS_TS_LANGUAGES, ...PYTHON_LANGUAGES, ...RUST_LANGUAGES],
  'registries.attributes': [...PYTHON_LANGUAGES, ...RUST_LANGUAGES],
  'registries.nameInjection': PYTHON_LANGUAGES,
  'registries.decorators': JS_TS_LANGUAGES,
  'registries.parameterDecorators': JS_TS_LANGUAGES,
  'registries.manifest': JS_TS_LANGUAGES,
  'registries.discover': JS_TS_LANGUAGES,
} as const;

/** A protocol list, named as its path under `protocols` (for example `registries.methods`). */
export type ProtocolKind = keyof typeof CONSUMERS;

/** The optional `languages` tag on a protocol entry, after validation. */
export interface LanguageScope {
  readonly languages?: readonly FrontEndLanguage[];
}

function isFrontEndLanguage(value: unknown): value is FrontEndLanguage {
  return FRONT_END_LANGUAGES.some((language) => language === value);
}

/**
 * Read and check the `languages` tag of one protocol entry. Returns the scope to attach (empty
 * when the entry has no tag), or `undefined` when the entry must be ignored. The entry's own fields
 * have already been validated by the caller.
 */
export function scopeEntry(
  raw: unknown,
  path: string,
  kind: ProtocolKind,
  problems: ConfigProblem[],
): LanguageScope | undefined {
  if (!isRecord(raw) || !('languages' in raw)) return {};

  const value = raw['languages'];
  if (!Array.isArray(value) || value.length === 0) {
    problems.push({
      path: `${path}.languages`,
      message: `must be a non-empty list of ${FRONT_END_LANGUAGES.join(', ')}; entry ignored`,
    });
    return undefined;
  }

  const named: FrontEndLanguage[] = [];
  let valid = true;
  value.forEach((item: unknown, index) => {
    if (!isFrontEndLanguage(item)) {
      problems.push({
        path: `${path}.languages[${index}]`,
        message: `must be one of ${FRONT_END_LANGUAGES.join(', ')}; entry ignored`,
      });
      valid = false;
    } else if (!named.includes(item)) {
      named.push(item);
    }
  });
  if (!valid) return undefined;

  const readers: readonly FrontEndLanguage[] = CONSUMERS[kind];
  const applies = named.filter((language) => readers.includes(language));
  for (const language of named) {
    if (!readers.includes(language)) {
      problems.push({
        path: `${path}.languages`,
        message: `${language} does not read ${kind} yet; ignored for ${language}`,
      });
    }
  }
  if (applies.length === 0) {
    problems.push({ path, message: 'applies to no language that reads it; entry ignored' });
    return undefined;
  }
  return { languages: applies };
}

/** The entry with its language scope attached, when it has one. */
export function withLanguages<T>(entry: T, scope: LanguageScope): T & LanguageScope {
  return (scope.languages ? { ...entry, languages: scope.languages } : entry) as T & LanguageScope;
}

/**
 * The entries a front end reads: those with no tag, and those tagged with one of its languages.
 * Undefined stays undefined, so an absent list is still absent.
 */
export function appliesTo<T>(
  entries: readonly T[] | undefined,
  languages: readonly FrontEndLanguage[],
): T[] | undefined {
  if (entries === undefined) return undefined;
  return entries.filter((entry) => {
    const scope = (entry as LanguageScope).languages;
    return scope === undefined || scope.some((language) => languages.includes(language));
  });
}

/** The events section, with its methods filtered for one front end. */
export function scopeEvents<T extends { readonly methods?: readonly unknown[] }>(
  events: T | undefined,
  languages: readonly FrontEndLanguage[],
): T | undefined {
  if (!events) return undefined;
  return {
    ...events,
    ...(events.methods ? { methods: appliesTo(events.methods, languages) } : {}),
  } as T;
}

/** The registries section, with every list filtered for one front end. */
export function scopeRegistries<T extends object>(
  registries: T | undefined,
  languages: readonly FrontEndLanguage[],
): T | undefined {
  if (!registries) return undefined;
  const source = registries as Record<string, unknown>;
  const scoped: Record<string, unknown> = { ...source };
  for (const key of [
    'methods',
    'decorators',
    'parameterDecorators',
    'nameInjection',
    'attributes',
    'manifest',
    'discover',
  ]) {
    const list = source[key];
    if (Array.isArray(list)) scoped[key] = appliesTo(list, languages);
  }
  return scoped as T;
}
