/**
 * Rust path resolution (V3 Phase 9.2, extended for `use` in 9.3). A path is resolved against the
 * module tree of one crate (names/module-index.ts), and against the crates it can name.
 *
 * A name in a module is found in this order: an item of the module, an explicit `use` binding,
 * then a glob import (`use path::*`). A glob reaches only the names visible to the importing
 * module: public names, and private names of a module the importer is inside. Two globs that
 * supply different targets for one name are `ambiguous-star-import`.
 *
 * Covered:
 * - `crate::`, `self::` and `super::` (repeatable). `::name` is an extern crate in edition 2018 and
 *   later, and the crate root in 2015.
 * - A first segment that is a local name or an extern crate. In 2018 and later both are "uniform
 *   paths", so a name that is both is an unresolved-module-path observation.
 * - Extern crates from the Phase 7 table, `extern crate ... as` aliases, and the standard crates
 *   (`std`, `core`, `alloc`, `proc_macro`, `test`). Other repository crates resolve through the
 *   crate index that the caller passes in.
 * - A path that continues past a type (`Type::assoc`) resolves to the type with the rest of the
 *   path, for the method rules of Phase 9.6.
 *
 * Not covered: enum variants (they are not symbols yet), so `Enum::Variant` resolves as an
 * associated path, and glob imports of an enum name nothing here.
 */
import type { ImportBinding, RustCrateIndex, RustModuleNode } from './module-index.js';
import type { RustNamespace } from './namespaces.js';

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

export type UnresolvedReason =
  'unresolved-module-path' | 'macro-generated-item' | 'ambiguous-star-import';

/** What a path means, before it becomes a graph target. */
export type Resolution =
  | { readonly kind: 'symbol'; readonly id: string }
  | { readonly kind: 'module'; readonly node: RustModuleNode; readonly id: string | undefined }
  | { readonly kind: 'extern'; readonly crate: string }
  | { readonly kind: 'associated'; readonly id: string; readonly rest: readonly string[] }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unresolved'; readonly reason: UnresolvedReason; readonly detail: string };

/** A graph-facing result of resolving a path. */
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
  /** A path that looks internal and does not resolve. */
  | {
      readonly kind: 'unresolved';
      readonly reason: UnresolvedReason;
      readonly subject: string;
      readonly detail: string;
    };

/** What one name means inside a module, while searching. */
type Hit =
  | Exclude<Resolution, { readonly kind: 'not-found' | 'unresolved' }>
  | { readonly kind: 'ambiguous'; readonly reason: UnresolvedReason; readonly detail: string }
  | { readonly kind: 'unresolved'; readonly reason: UnresolvedReason; readonly detail: string };

/** The meaning of a first segment that names a crate. */
type CrateEntry =
  | { readonly kind: 'extern'; readonly crate: string }
  | { readonly kind: 'repo'; readonly index: RustCrateIndex };

/**
 * Resolves a path written in module `from`, whose last segment is in namespace `ns`, and returns
 * a graph-facing target. Never throws: every failure is a result.
 */
export function resolvePath(
  path: RustPath,
  ns: RustNamespace,
  from: RustModuleNode,
  crate: RustCrateIndex,
  env: RustNameEnvironment,
): PathTarget {
  const resolution = resolveName(path, ns, from, crate, env);
  switch (resolution.kind) {
    case 'module':
      return resolution.id !== undefined
        ? { kind: 'symbol', id: resolution.id }
        : { kind: 'file', path: resolution.node.file };
    case 'unresolved':
      return {
        kind: 'unresolved',
        reason: resolution.reason,
        subject: `${path.global ? '::' : ''}${path.segments.join('::')}`,
        detail: resolution.detail,
      };
    default:
      return resolution;
  }
}

/** Resolves a path to what it means. Used by resolvePath, and by bindImports for `use` paths. */
export function resolveName(
  path: RustPath,
  ns: RustNamespace,
  from: RustModuleNode,
  crate: RustCrateIndex,
  env: RustNameEnvironment,
  importPath = false,
): Resolution {
  const { segments } = path;
  const [first] = segments;
  if (first === undefined) return failure('empty path');

  let node = from;
  let index = 0;
  // The crate whose `extern crate` aliases apply at the current node. It changes when the walk enters
  // another repository crate, as in `grep::printer::...`.
  let owner: RustCrateIndex = crate;

  if (path.global) {
    if (crate.edition === '2015') {
      node = crate.root;
    } else {
      const entry = crateEntry(first, crate, env);
      if (entry === undefined) return failure(`no extern crate named \`${first}\``);
      if (entry.kind === 'extern') return { kind: 'extern', crate: entry.crate };
      node = entry.index.root;
      owner = entry.index;
      index = 1;
    }
  } else if (first === 'crate') {
    node = crate.root;
    index = 1;
  } else if (first === 'self') {
    node = nearestModule(from);
    index = 1;
  } else if (first === 'super') {
    node = nearestModule(from);
    while (segments[index] === 'super') {
      if (node.parent === null) return failure('`super` goes past the crate root');
      node = node.parent;
      index++;
    }
  } else {
    // A uniform path: the first segment is a local name in the current module, or a crate.
    const local = lookupScoped(from, first, segments.length === 1 ? ns : 'type', from, new Set());
    const entry = crateEntry(first, crate, env);
    // In a `use` the two names conflict, which Rust rejects. Elsewhere the local item shadows the crate.
    if (importPath && local !== undefined && local.kind !== 'extern' && entry !== undefined) {
      return failure(`\`${first}\` names both a local item and an extern crate`);
    }
    if (local === undefined) {
      if (entry === undefined) return { kind: 'not-found' };
      if (entry.kind === 'extern') return { kind: 'extern', crate: entry.crate };
      node = entry.index.root;
      owner = entry.index;
      index = 1;
    }
    // Otherwise the first segment is local, and the walk below resolves it.
  }

  // A path that is only prefixes (`super`, `self::super`, `crate`) names the module it reaches,
  // as in `use super::*`.
  if (index > 0 && index === segments.length) return { kind: 'module', node, id: undefined };

  for (let k = index; k < segments.length; k++) {
    const name = segments[k];
    if (name === undefined) break;
    const last = k === segments.length - 1;
    const hit =
      k === 0 && node === from
        ? lookupScoped(node, name, last ? ns : 'type', from, new Set())
        : lookupIn(node, name, last ? ns : 'type', from, new Set());
    if (hit === undefined && node.parent === null && owner.externCrates.has(name)) {
      // An `extern crate ... as` alias at a crate root names the crate it renames (`pub extern crate grep_printer as printer;`).
      const entry = crateEntry(name, owner, env);
      if (entry?.kind === 'extern') return { kind: 'extern', crate: entry.crate };
      if (entry?.kind === 'repo') {
        if (k === segments.length - 1)
          return { kind: 'module', node: entry.index.root, id: undefined };
        node = entry.index.root;
        owner = entry.index;
        continue;
      }
    }
    if (hit === undefined) return missingName(node, name);
    switch (hit.kind) {
      case 'ambiguous':
      case 'unresolved':
        return { kind: 'unresolved', reason: hit.reason, detail: hit.detail };
      case 'extern':
        return hit;
      case 'associated':
        return { kind: 'associated', id: hit.id, rest: [...hit.rest, ...segments.slice(k + 1)] };
      case 'symbol':
        return last ? hit : { kind: 'associated', id: hit.id, rest: segments.slice(k + 1) };
      case 'module':
        if (!last) {
          node = hit.node;
          continue;
        }
        return hit;
    }
  }
  return failure('a path needs a name after its prefix');
}

/**
 * A name a module does not contain. A module with an item-level macro call may have that call generate the
 * name, so the name is reported as `macro-generated-item`; any other module reports a plain miss.
 */
function missingName(node: RustModuleNode, name: string): Resolution {
  const [macro] = node.macroCalls;
  if (macro === undefined) return failure(`no \`${name}\` in ${describe(node)}`);
  return {
    kind: 'unresolved',
    reason: 'macro-generated-item',
    detail: `\`${name}\` may be generated by \`${macro}!\` in ${describe(node)}`,
  };
}

/**
 * What `name` means inside `node`, in namespace `ns`, as seen from module `importer`.
 * Items come first, then explicit `use` bindings, then glob imports.
 */
function lookupIn(
  node: RustModuleNode,
  name: string,
  ns: RustNamespace,
  importer: RustModuleNode,
  visited: Set<string>,
): Hit | undefined {
  if (ns === 'type') {
    if (node.ambiguous.has(name)) {
      return {
        kind: 'ambiguous',
        reason: 'unresolved-module-path',
        detail: `\`${name}\` is declared in more than one file in ${describe(node)}`,
      };
    }
    const child = node.children.get(name);
    if (child !== undefined) {
      const id = node.tables.get(node.scope)?.type.get(name);
      return { kind: 'module', node: child, id: child.inline ? id : undefined };
    }
  }
  const id = node.tables.get(node.scope)?.[ns].get(name);
  if (id !== undefined) return { kind: 'symbol', id };
  const explicit = node.imports.get(ns)?.get(name);
  if (explicit !== undefined) return fromBinding(explicit);
  return lookupGlobs(node, name, ns, importer, visited);
}

/**
 * Searches a block and then the blocks and module around it (9.8). A block sees the names of the
 * function it is in; a module does not see into its children.
 */
function lookupScoped(
  node: RustModuleNode,
  name: string,
  ns: RustNamespace,
  importer: RustModuleNode,
  visited: Set<string>,
): Hit | undefined {
  for (
    let scope: RustModuleNode | null = node;
    scope !== null;
    scope = scope.block ? scope.parent : null
  ) {
    const hit = lookupIn(scope, name, ns, importer, visited);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The module a block belongs to. `self`, `super` and `crate` name modules, so they start here. */
function nearestModule(node: RustModuleNode): RustModuleNode {
  let current = node;
  while (current.block && current.parent !== null) current = current.parent;
  return current;
}

/** The names a module's glob imports bring in. Two different targets for one name are ambiguous. */
function lookupGlobs(
  node: RustModuleNode,
  name: string,
  ns: RustNamespace,
  importer: RustModuleNode,
  visited: Set<string>,
): Hit | undefined {
  const found = new Map<string, Hit>();
  for (const glob of node.globs) {
    if (glob.source === null) continue;
    if (!glob.isPub && !isWithin(importer, node)) continue;
    const hit = globFind(glob.source, name, ns, importer, visited);
    if (hit === undefined) continue;
    if (hit.kind === 'ambiguous') return hit;
    found.set(hitKey(hit), hit);
  }
  if (found.size > 1) {
    return {
      kind: 'ambiguous',
      reason: 'ambiguous-star-import',
      detail: `\`${name}\` is supplied by more than one glob import in ${describe(node)}`,
    };
  }
  return [...found.values()][0];
}

/** What a glob of `source` brings in for `name`, as seen from `importer`. */
function globFind(
  source: RustModuleNode,
  name: string,
  ns: RustNamespace,
  importer: RustModuleNode,
  visited: Set<string>,
): Hit | undefined {
  const key = `${source.file}\u0000${source.path}\u0000${name}\u0000${ns}`;
  if (visited.has(key)) return undefined;
  visited.add(key);

  const visible = isWithin(importer, source);
  const id = source.tables.get(source.scope)?.[ns].get(name);
  if (id !== undefined && (visible || source.visibility.get(id) !== 'private')) {
    return { kind: 'symbol', id };
  }
  if (ns === 'type') {
    const child = source.children.get(name);
    // A private child module is reached only from inside its parent, as its items are (gap 8).
    if (child !== undefined && (visible || child.reachable)) {
      const childId = source.tables.get(source.scope)?.type.get(name);
      return { kind: 'module', node: child, id: child.inline ? childId : undefined };
    }
  }
  const explicit = source.imports.get(ns)?.get(name);
  if (explicit !== undefined && (visible || explicit.isPub)) return fromBinding(explicit);
  return lookupGlobs(source, name, ns, importer, visited);
}

/** Whether `inner` is `outer` or one of its descendants. */
function isWithin(inner: RustModuleNode, outer: RustModuleNode): boolean {
  for (let node: RustModuleNode | null = inner; node !== null; node = node.parent) {
    if (node === outer) return true;
  }
  return false;
}

function fromBinding(binding: ImportBinding): Hit {
  switch (binding.kind) {
    case 'symbol':
      return { kind: 'symbol', id: binding.id };
    case 'module':
      return { kind: 'module', node: binding.node, id: binding.id };
    case 'extern':
      return { kind: 'extern', crate: binding.crate };
    case 'associated':
      return { kind: 'associated', id: binding.id, rest: binding.rest };
    case 'unresolved':
      return { kind: 'unresolved', reason: binding.reason, detail: binding.detail };
  }
}

function hitKey(hit: Hit): string {
  switch (hit.kind) {
    case 'symbol':
      return `s:${hit.id}`;
    case 'module':
      return `m:${hit.node.file}:${hit.node.path}`;
    case 'extern':
      return `e:${hit.crate}`;
    case 'associated':
      return `a:${hit.id}:${hit.rest.join('::')}`;
    case 'ambiguous':
    case 'unresolved':
      return 'x';
  }
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

function failure(detail: string): Resolution {
  return { kind: 'unresolved', reason: 'unresolved-module-path', detail };
}

function describe(node: RustModuleNode): string {
  return node.path === '' ? 'the crate root' : `module \`${node.path}\``;
}
