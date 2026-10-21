/**
 * The shared owner rule (Phase 2.6). Every front end reports the scopes that enclose a fact, from
 * outermost to innermost, and this rule names the owner. The rule is the same for every language:
 *
 * - The owner is the innermost scope that owns code: a class, a function, a method, or a variable
 *   holding a function.
 * - A method or class is qualified by the classes and named object literals that enclose it:
 *   `Outer.Inner.method` (D6), or `api.load` for a method of `const api = { load() {} }`.
 * - Functions are not qualified. A function nested in another function is its own owner.
 * - Code outside every owner belongs to the file, and the owner id is the file path.
 */

/** One scope a front end found while walking outward from a fact. */
export type OwnerScope =
  | { readonly kind: 'class'; readonly name: string }
  | { readonly kind: 'object'; readonly name: string }
  | { readonly kind: 'method'; readonly name: string }
  | { readonly kind: 'function'; readonly name: string }
  | { readonly kind: 'function-variable'; readonly name: string };

/**
 * The owner id of a fact, given the scopes that enclose it from outermost to innermost. Pass an
 * empty chain for module-level code.
 */
export function ownerIdOf(filePath: string, chain: readonly OwnerScope[]): string {
  for (let index = chain.length - 1; index >= 0; index--) {
    const scope = chain[index];
    if (scope === undefined) continue;
    const qualifier =
      scope.kind === 'class' || scope.kind === 'method'
        ? chain
            .slice(0, index)
            .flatMap((outer) =>
              outer.kind === 'class' || outer.kind === 'object' ? [outer.name] : [],
            )
        : [];
    return `${filePath}:${[...qualifier, scope.name].join('.')}`;
  }
  return filePath;
}
