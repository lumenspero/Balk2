/**
 * Flattens a `use` declaration into one entry per name it brings in or imports (V3 Phase 9.3).
 *
 * `use a::{b, c as d, e::{self, f}, _ as _, g::*}` gives entries for `a::b` (bound `b`),
 * `a::c` (bound `d`), `a::e` (bound `e`), `a::e::f` (bound `f`) and the glob `a::g::*`. A `self`
 * in a group names the group's own path. `as _` binds nothing, but the entry still names a target.
 */
import type { Span, UseTree } from '../items.js';

export interface UseEntry {
  /** The full path the entry names, without a leading `::` (the parser does not keep it). */
  readonly path: readonly string[];
  /** The name the entry binds in its scope, or null for `as _` and for globs. */
  readonly bind: string | null;
  /** True for `path::*`, which brings in every visible name of `path`. */
  readonly glob: boolean;
  /** True when the path starts with `::`, which names an extern crate in 2018+ and the root in 2015. */
  readonly global: boolean;
  /** The span of the `use` declaration. */
  readonly span: Span;
}

export function flattenUse(tree: UseTree | null, span: Span): UseEntry[] {
  if (tree === null) return [];
  const out: UseEntry[] = [];
  const visit = (node: UseTree): void => {
    if (node.kind === 'glob') {
      out.push({ path: node.path, bind: null, glob: true, global: node.global, span });
      return;
    }
    if (node.kind === 'nested') {
      for (const item of node.items) visit(item);
      return;
    }
    // A name. Its path already includes any enclosing prefix.
    const last = node.path[node.path.length - 1];
    if (last === undefined) return;
    if (last === 'self') {
      const path = node.path.slice(0, -1);
      const name = path[path.length - 1];
      const bind = node.alias === '_' ? null : (node.alias ?? name ?? null);
      out.push({ path, bind, glob: false, global: node.global, span });
      return;
    }
    const bind = node.alias === '_' ? null : (node.alias ?? last);
    out.push({ path: node.path, bind, glob: false, global: node.global, span });
  };
  visit(tree);
  return out;
}
