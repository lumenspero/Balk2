/**
 * The exports of one Rust library crate (V3 Phase 9.4).
 *
 * An item is exported when some path from the crate root reaches it through public modules or
 * `pub use`. The walk starts at the crate root and follows:
 * - every item declared `pub` in a module it reaches (`pub(crate)` and private items are not);
 * - every `pub use` binding in such a module: its symbol, or the module it names, which is reached;
 * - every `pub use path::*` glob: the source module's public contents are exported too, even when
 *   the source is private, which is the usual `mod inner; pub use inner::*;` layout;
 * - every child module declared `pub`.
 *
 * A module that is not reached this way contributes nothing, even when its items are declared
 * `pub`. The walk is over a set of modules, so it reaches its fixed point.
 *
 * Each export is recorded with the file it is written in: the file of a declared item, or the file
 * of the `pub use`. Only modules of this crate are followed, so a re-export of another crate's item
 * still names that item but does not walk into the other crate.
 */
import type { RustCrateIndex, RustModuleNode } from './module-index.js';
import type { RustNamespace } from './namespaces.js';

/** One export: the symbol `id`, exported from the file `from`. */
export interface ExportEdge {
  readonly from: string;
  readonly id: string;
}

const NAMESPACES: readonly RustNamespace[] = ['type', 'value', 'macro'];

/** The exports of a library crate, one per (file, symbol) pair, sorted by file and then id. */
export function computeExports(crate: RustCrateIndex): ExportEdge[] {
  const edges = new Map<string, ExportEdge>();
  const add = (from: string, id: string): void => {
    const key = `${from}\u0000${id}`;
    if (!edges.has(key)) edges.set(key, { from, id });
  };

  const visited = new Set<RustModuleNode>();
  const pending: RustModuleNode[] = [crate.root];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (visited.has(node) || node.tables !== crate.namespaces) continue;
    visited.add(node);

    // Items declared `pub` in this module.
    const scope = node.tables.get(node.scope);
    if (scope !== undefined) {
      for (const ns of NAMESPACES) {
        for (const id of scope[ns].values()) {
          if (crate.visibility.get(id) === 'public') add(node.file, id);
        }
      }
    }

    // `pub use` bindings: a symbol is exported, and a module is reached.
    for (const bindings of node.imports.values()) {
      for (const binding of bindings.values()) {
        if (!binding.isPub) continue;
        if (binding.kind === 'symbol' || binding.kind === 'associated') {
          add(node.file, binding.id);
        } else if (binding.kind === 'module') {
          pending.push(binding.node);
        }
      }
    }

    // `pub use path::*` exports the public contents of the source.
    for (const glob of node.globs) {
      if (glob.isPub && glob.source !== null) pending.push(glob.source);
    }

    // Child modules declared `pub` are reached.
    for (const child of node.children.values()) {
      if (child.public) pending.push(child);
    }
  }

  return [...edges.values()].sort((a, b) =>
    a.from === b.from ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.from < b.from ? -1 : 1,
  );
}
