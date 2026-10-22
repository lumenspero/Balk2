/**
 * Rust namespaces (V3 Phase 9.1).
 *
 * Each module has three separate namespaces. A name in one does not clash with the same name in
 * another, so `struct Foo;` and `fn Foo()` can coexist:
 *
 * - `type`: modules, structs, enums, unions, traits and type aliases. A tuple or unit struct is
 *   also in `value`, because its constructor is a value.
 * - `value`: functions, constants and statics, and tuple or unit struct constructors.
 * - `macro`: `macro_rules!` macros, keyed by their bare name (invoked as `name!`).
 *
 * A scope is the file path, plus `:` and the inline module path for items inside `mod x { }`
 * (`src/lib.rs:tests`). The tables map a bare name to the symbol id it resolves to in that scope.
 */
import type { Item } from '../items.js';

export type RustNamespace = 'type' | 'value' | 'macro';

/** The name-to-symbol-id table of each namespace in one scope. */
export interface RustScopeNamespaces {
  readonly type: Map<string, string>;
  readonly value: Map<string, string>;
  readonly macro: Map<string, string>;
}

/** Tables for every scope in the crate, keyed by scope (see the module comment). */
export type RustNamespaceTables = Map<string, RustScopeNamespaces>;

/**
 * The namespaces an item occupies. Items that define no name (`use`, `extern crate`, `impl`,
 * `mod foo;` whose body is in another file) occupy none.
 */
export function namespacesOf(item: Item): readonly RustNamespace[] {
  switch (item.kind) {
    case 'fn':
    case 'const':
    case 'static':
      return ['value'];
    case 'struct':
      return item.shape === 'named' ? ['type'] : ['type', 'value'];
    case 'enum':
    case 'union':
    case 'trait':
    case 'type':
      return ['type'];
    case 'mod':
      return item.inline ? ['type'] : [];
    case 'macro_rules':
      return ['macro'];
    default:
      return [];
  }
}

/** Records `name` in one namespace of a scope. The first definition wins, as rustc keeps one. */
export function recordName(
  tables: RustNamespaceTables,
  scope: string,
  namespaces: readonly RustNamespace[],
  name: string,
  id: string,
): void {
  let table = tables.get(scope);
  if (table === undefined) {
    table = { type: new Map(), value: new Map(), macro: new Map() };
    tables.set(scope, table);
  }
  for (const namespace of namespaces) {
    if (!table[namespace].has(name)) table[namespace].set(name, id);
  }
}
