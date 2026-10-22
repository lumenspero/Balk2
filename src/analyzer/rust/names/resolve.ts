/**
 * Rust path resolution (V3 Phase 9.2). A path is resolved against the module tree and the
 * namespace tables of one crate (names/module-index.ts), and against the crates it can name.
 *
 * Covered:
 * - `crate::`, `self::` and `super::` (repeatable). `::name` is an extern crate in edition 2018 and
 *   later, and the crate root in 2015.
 * - A first segment that is a local item or an extern crate. In 2018 and later both are "uniform
 *   paths", so a name that is both is an unresolved-module-path observation.
 * - Extern crates from the Phase 7 table, `extern crate ... as` aliases, and the standard crates
 *   (`std`, `core`, `alloc`, `proc_macro`, `test`). Other repository crates resolve through the
 *   crate index that the caller passes in.
 * - A path that continues past a type (`Type::assoc`) resolves to the type with the rest of the
 *   path, for the method rules of Phase 9.6.
 *
 * Not covered here, and reported by later sub-phases: names brought in by `use` (9.3, which must
 * be checked before a miss is reported as unresolved), glob imports, and the 2015 rules for `use`
 * paths.
 */
import type { RustCrateIndex, RustModuleNode } from './module-index.js';
import type { RustNamespace, RustNamespaceTables } from './namespaces.js';

/** Crates that ship with Rust. They are outside the repository unless a local item shadows them. */
const STANDARD_CRATES: readonly string[] = ['std', 'core', 'alloc', 'proc_macro', 'test'];

/** The crates a path can name, from outside the crate being resolved. */
export interface RustNameEnvironment {
  /** Crates outside the repository, by the name code uses (from the Phase 7 extern table). */
  readonly externs: ReadonlySet<string>;
  /** Crates inside the repository, by the name code uses (from the Phase 7 dependency edges). */
  readonly repoCrates: ReadonlyMap<string, RustCrateIndex>;
}

/** A path as written: `crate::a::B`, `::serde::Serialize`, `Vec::new`. */
export interface RustPath {
  readonly global: boolean;
  readonly segments: readonly string[];
}

export type PathTarget =
  /** The path names a symbol in the repository. */
  | { readonly kind: 'symbol'; readonly id: string }
  /** The path names a file module, which has no symbol of its own. */
  | { readonly kind: 'file'; readonly path: string }
  /** The path starts in a crate outside the repository. */
  | { readonly kind: 'extern'; readonly crate: string }
  /** The path continues past a repository type; `rest` is resolved by the caller (Phase 9.6). */
  | { readonly kind: 'associated'; readonly id: string; readonly rest: readonly string[] }
  /** Neither a repository item nor an extern crate: a prelude or std item, or an unknown name. */
  | { readonly kind: 'not-found' }
  /** An internal-looking path that does not resolve. */
  | {
      readonly kind: 'unresolved';
      readonly reason: 'unresolved-module-path';
      readonly subject: string;
      readonly detail: string;
    };

/** What one name means inside a module: a symbol, a module, or a name defined under several cfgs. */
type Hit =
  | { readonly kind: 'symbol'; readonly id: string }
  | { readonly kind: 'module'; readonly node: RustModuleNode; readonly id: string | undefined }
  | { readonly kind: 'ambiguous' };

/** The meaning of a first segment that names a crate. */
type CrateEntry =
  | { readonly kind: 'extern'; readonly crate: string }
  | { readonly kind: 'repo'; readonly index: RustCrateIndex };

/**
 * Resolves a path written in module `from`, whose last segment is in namespace `ns`.
 * Never throws: every failure is a result.
 */
export function resolvePath(
  path: RustPath,
  ns: RustNamespace,
  from: RustModuleNode,
  crate: RustCrateIndex,
  env: RustNameEnvironment,
): PathTarget {
  const subject = `${path.global ? '::' : ''}${path.segments.join('::')}`;
  const fail = (detail: string): PathTarget => ({
    kind: 'unresolved',
    reason: 'unresolved-module-path',
    subject,
    detail,
  });
  const [first] = path.segments;
  if (first === undefined) return fail('empty path');

  // The module the walk starts in, the crate whose tables read it, and how many segments are used.
  let node = from;
  let cur = crate;
  let index = 0;

  if (path.global) {
    if (crate.edition === '2015') {
      node = crate.root;
    } else {
      const entry = crateEntry(first, crate, env);
      if (entry === undefined) return fail(`no extern crate named \`${first}\``);
      if (entry.kind === 'extern') return { kind: 'extern', crate: entry.crate };
      cur = entry.index;
      node = entry.index.root;
      index = 1;
    }
  } else if (first === 'crate') {
    node = crate.root;
    index = 1;
  } else if (first === 'self') {
    index = 1;
  } else if (first === 'super') {
    while (path.segments[index] === 'super') {
      if (node.parent === null) return fail('`super` goes past the crate root');
      node = node.parent;
      index++;
    }
  } else {
    // A uniform path: the first segment is a local item in the current module, or a crate.
    const local = lookupIn(crate.namespaces, from, first, path.segments.length === 1 ? ns : 'type');
    const entry = crateEntry(first, crate, env);
    if (local !== undefined && entry !== undefined) {
      return fail(`\`${first}\` names both a local item and an extern crate`);
    }
    if (local === undefined && entry !== undefined) {
      if (entry.kind === 'extern') return { kind: 'extern', crate: entry.crate };
      cur = entry.index;
      node = entry.index.root;
      index = 1;
    } else if (local === undefined) {
      return { kind: 'not-found' };
    }
    // Otherwise the first segment is local, and the walk below resolves it.
  }

  for (let k = index; k < path.segments.length; k++) {
    const name = path.segments[k];
    if (name === undefined) break;
    const last = k === path.segments.length - 1;
    const hit = lookupIn(cur.namespaces, node, name, last ? ns : 'type');
    if (hit === undefined) return fail(`no \`${name}\` in ${describe(node)}`);
    if (hit.kind === 'ambiguous') {
      return fail(`\`${name}\` is declared in more than one file in ${describe(node)}`);
    }
    if (hit.kind === 'symbol') {
      if (last) return { kind: 'symbol', id: hit.id };
      return { kind: 'associated', id: hit.id, rest: path.segments.slice(k + 1) };
    }
    if (!last) {
      node = hit.node;
      continue;
    }
    if (hit.id !== undefined) return { kind: 'symbol', id: hit.id };
    return { kind: 'file', path: hit.node.file };
  }

  return fail('a path needs a name after its prefix');
}

/** What a name means inside one module, in one namespace. */
function lookupIn(
  namespaces: RustNamespaceTables,
  node: RustModuleNode,
  name: string,
  ns: RustNamespace,
): Hit | undefined {
  if (ns === 'type') {
    if (node.ambiguous.has(name)) return { kind: 'ambiguous' };
    const child = node.children.get(name);
    if (child !== undefined) {
      const id = namespaces.get(node.scope)?.type.get(name);
      return { kind: 'module', node: child, id: child.inline ? id : undefined };
    }
  }
  const id = namespaces.get(node.scope)?.[ns].get(name);
  return id === undefined ? undefined : { kind: 'symbol', id };
}

/** The crate a first segment names: an `extern crate` alias, a repository crate, or an extern crate. */
function crateEntry(
  name: string,
  crate: RustCrateIndex,
  env: RustNameEnvironment,
): CrateEntry | undefined {
  const crateName = crate.externCrates.get(name) ?? name;
  const repo = env.repoCrates.get(crateName);
  if (repo !== undefined) return { kind: 'repo', index: repo };
  if (env.externs.has(crateName) || STANDARD_CRATES.includes(crateName)) {
    return { kind: 'extern', crate: crateName };
  }
  return undefined;
}

function describe(node: RustModuleNode): string {
  return node.path === '' ? 'the crate root' : `module \`${node.path}\``;
}
