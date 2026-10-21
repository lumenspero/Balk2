import type { CallSite, FactLanguage, FileFacts } from './types.js';

/**
 * The shared mechanism-engine contract (Phase 2.3). An engine consumes facts plus a catalog and
 * produces graph output. Engines never see syntax trees, so one engine serves every language.
 */

/** Every catalog entry names the languages it applies to. */
export interface CatalogEntry {
  readonly languages: readonly FactLanguage[];
}

/** The entries of a catalog that apply to one language. */
export function entriesFor<T extends CatalogEntry>(
  entries: readonly T[],
  language: FactLanguage,
): readonly T[] {
  return entries.filter((entry) => entry.languages.includes(language));
}

/**
 * How a catalog entry selects calls. A `resolved` target matches what the front end resolved: an
 * external name such as `std::fs::read_to_string`, a symbol id, or a method on a resolved receiver
 * type (`pathlib.Path.write_text`, or `src/b.ts:User.save`). A bare method name matches only when
 * the entry says `receiver: 'any'`, so text alone never creates an edge.
 */
export type CallMatcher =
  | { readonly kind: 'resolved'; readonly target: string }
  | { readonly kind: 'method'; readonly method: string; readonly receiver: 'any' };

/** True when a call matches the entry's selector. */
export function matchesCall(call: CallSite, matcher: CallMatcher): boolean {
  if (matcher.kind === 'method') {
    return call.methodName === matcher.method;
  }

  const { callee, receiver, methodName } = call;
  if (callee.kind === 'symbol' && callee.id === matcher.target) return true;
  if (callee.kind === 'external' && callee.name === matcher.target) return true;

  const receiverType = receiver?.type;
  if (receiverType === undefined || methodName === undefined) return false;
  if (receiverType.kind === 'external') {
    return `${receiverType.name}.${methodName}` === matcher.target;
  }
  if (receiverType.kind === 'symbol') {
    return `${receiverType.id}.${methodName}` === matcher.target;
  }
  return false;
}

/** What an engine reads: the facts of every front end and the catalog it applies. */
export interface EngineInput<C extends CatalogEntry> {
  readonly files: readonly FileFacts[];
  readonly catalog: readonly C[];
}

/** One mechanism family, such as events or registries, as a single engine. */
export interface MechanismEngine<C extends CatalogEntry, O> {
  readonly family: string;
  run(input: EngineInput<C>): O;
}

/** The facts from files of one language, in file order. */
export function filesFor(
  files: readonly FileFacts[],
  language: FactLanguage,
): readonly FileFacts[] {
  return files.filter((file) => file.language === language);
}
