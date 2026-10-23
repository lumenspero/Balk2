/**
 * The module tree of one Rust crate, with each module's namespace tables, visibility and `use`
 * bindings (V3 Phase 9.2 and 9.3).
 *
 * The root of the tree is the crate root file. A `mod name;` is a child whose items are in the
 * file that `moduleFileCandidates` finds (the Phase 8 rules, including `#[path]`). A `mod name { }`
 * is a child whose items are in the same file.
 *
 * `use` declarations are collected as pending entries and bound later, by bindImports
 * (names/imports.ts), because a `use` can name something another `use` brings in.
 *
 * A child declared twice in the same file (`#[cfg(a)] mod x { }` and `#[cfg(b)] mod x { }`) is one
 * module whose items are both present. A child declared in two different files is ambiguous, and
 * names through it resolve to nothing. The module tree (Phase 8) already reports that conflict.
 */
import type { Visibility } from '../../../facts/types.js';
import { parseRustFile, type Fragment, type Item, type RustFile, type Span } from '../items.js';
import { isModRsFile, moduleFileCandidates, type InlineModule } from '../modules/paths.js';
import { pathAttrOf } from '../modules/tree.js';
import type { RustNamespace, RustNamespaceTables } from './namespaces.js';
import { analyzeRustSymbols } from '../symbols.js';
import { blockKey, nestedItemsOf } from '../nested.js';
import { flattenUse, type UseEntry } from './use-tree.js';

/** What a `use` binds a name to. `isPub` is true for `pub use`, which other modules can reach. */
export type ImportBinding =
  | { readonly kind: 'symbol'; readonly id: string; readonly isPub: boolean }
  | {
      readonly kind: 'module';
      readonly node: RustModuleNode;
      readonly id: string | undefined;
      readonly isPub: boolean;
    }
  | { readonly kind: 'extern'; readonly crate: string; readonly isPub: boolean }
  | {
      readonly kind: 'associated';
      readonly id: string;
      readonly rest: readonly string[];
      readonly isPub: boolean;
    };

/** A `use path::*` in a module. A null source is an extern or associated glob, which names nothing here. */
export interface GlobBinding {
  readonly source: RustModuleNode | null;
  readonly isPub: boolean;
}

export interface RustModuleNode {
  /** The module's path in the crate: `''` for the crate root, `util` or `models::nested` otherwise. */
  readonly path: string;
  /** True for `mod name { }`. False for the crate root and for a module loaded from a file. */
  readonly inline: boolean;
  /** The file that holds the module's items. */
  readonly file: string;
  /** The module's scope key in the namespace tables (see names/namespaces.ts). */
  readonly scope: string;
  /** Whether the module is declared `pub`, so its items can be reached from outside the crate. */
  readonly public: boolean;
  /** The declaring module, or null at the crate root. */
  readonly parent: RustModuleNode | null;
  readonly children: Map<string, RustModuleNode>;
  /** Child names declared in two different files. Names through them resolve to nothing. */
  readonly ambiguous: Set<string>;
  /** The namespace tables of the whole crate, shared by every module in it. */
  readonly tables: RustNamespaceTables;
  /** The visibility of every item in the crate, by symbol id. Shared by every module in it. */
  readonly visibility: ReadonlyMap<string, Visibility>;
  /** Names bound by `use` in this module, per namespace. An item of the same name takes precedence. */
  readonly imports: Map<RustNamespace, Map<string, ImportBinding>>;
  /** True for a block: the items declared in a function body. Its parent is the scope around it. */
  readonly block: boolean;
  readonly globs: GlobBinding[];
}

/** A `use` entry that has not been bound yet, with the module it is written in. */
export interface PendingUse {
  readonly owner: RustModuleNode;
  readonly entry: UseEntry;
  readonly isPub: boolean;
}

/** An `impl` block, with the module it is written in. Bound by bindTypeRelations. */
export interface PendingImpl {
  readonly owner: RustModuleNode;
  /** The `impl` item itself, so the functions written inside it can be matched to it. */
  readonly item: Extract<Item, { kind: 'impl' }>;
  readonly span: Span;
  readonly selfTy: Fragment;
  /** The trait of `impl Trait for Type`, or null for an inherent impl. */
  readonly trait: Fragment | null;
  /** The names of the impl's type parameters, which a self type may name. */
  readonly generics: readonly string[];
}

/** A `trait` declaration, with the module it is written in. */
export interface PendingTrait {
  readonly owner: RustModuleNode;
  readonly name: string;
  readonly span: Span;
  readonly supertraits: Fragment | null;
}

/** A function declared in the crate: a free function, or a method of an `impl` or `trait` (V3 Phase 9.6). */
export interface PendingFunction {
  readonly owner: RustModuleNode;
  /** The symbol id the function is declared under. */
  readonly id: string;
  readonly item: Extract<Item, { kind: 'fn' }>;
  /** The `impl` or `trait` item the function is written in, or null for a free function. */
  readonly container: Extract<Item, { kind: 'impl' | 'trait' }> | null;
  /** The ABI as written, from the function or the `extern` block it is in, or null. */
  readonly abi: string | null;
  /** True when the function carries `#[no_mangle]`. */
  readonly noMangle: boolean;
}

/** A named item whose id other passes need: a type, a const or a static (V3 Phase 9.7). */
export type PendingDeclItem = Extract<
  Item,
  { kind: 'struct' | 'union' | 'enum' | 'type' | 'const' | 'static' }
>;

export interface PendingDecl {
  readonly owner: RustModuleNode;
  readonly id: string;
  readonly item: PendingDeclItem;
}

export interface RustCrateIndex {
  readonly root: RustModuleNode;
  /** Names of every scope in the crate's files, keyed by scope. */
  readonly namespaces: RustNamespaceTables;
  /** The crate's edition, such as `2015` or `2021`. */
  readonly edition: string;
  /** The `extern crate` items at the crate root, as local name to crate name. */
  readonly externCrates: ReadonlyMap<string, string>;
  readonly visibility: ReadonlyMap<string, Visibility>;
  /** Every `use` entry in the crate, in source order. Bound by bindImports. */
  readonly uses: readonly PendingUse[];
  /** Every `impl` block in the crate, in source order. */
  readonly impls: readonly PendingImpl[];
  /** Every `trait` declaration in the crate, in source order. */
  readonly traits: readonly PendingTrait[];
  /** Every function in the crate, in source order. */
  readonly functions: readonly PendingFunction[];
  /** Every struct, union, enum, type alias, const and static in the crate. */
  readonly decls: readonly PendingDecl[];
}

export interface CrateIndexInput {
  /** Repository-relative crate root file */
  readonly root: string;
  /** Repository-relative files, with `/` separators */
  readonly files: ReadonlySet<string>;
  readonly readText: (file: string) => string;
  readonly edition: string;
}

interface Build {
  readonly input: CrateIndexInput;
  readonly namespaces: RustNamespaceTables;
  readonly visibility: Map<string, Visibility>;
  readonly uses: PendingUse[];
  readonly impls: PendingImpl[];
  readonly traits: PendingTrait[];
  readonly functions: PendingFunction[];
  readonly decls: PendingDecl[];
  readonly fnIds: Map<Extract<Item, { kind: 'fn' }>, string>;
  readonly loaded: Set<string>;
}

/** Builds the module tree, namespace tables and pending `use` entries of one crate. */
export function buildCrateIndex(input: CrateIndexInput): RustCrateIndex {
  const build: Build = {
    input,
    namespaces: new Map(),
    visibility: new Map(),
    uses: [],
    impls: [],
    traits: [],
    functions: [],
    decls: [],
    fnIds: new Map(),
    loaded: new Set([input.root]),
  };
  const rootFile = loadFile(build, input.root);
  const root = newNode(build, {
    path: '',
    inline: false,
    file: input.root,
    scope: input.root,
    parent: null,
    public: true,
  });
  visitItems(build, root, rootFile.items, '', [], true);

  const externCrates = new Map<string, string>();
  for (const item of rootFile.items) {
    if (item.kind === 'extern_crate') externCrates.set(item.alias ?? item.name, item.name);
  }
  return {
    root,
    namespaces: build.namespaces,
    edition: input.edition,
    externCrates,
    visibility: build.visibility,
    uses: build.uses,
    impls: build.impls,
    traits: build.traits,
    functions: build.functions,
    decls: build.decls,
  };
}

function loadFile(build: Build, file: string): RustFile {
  const parsed = parseRustFile(build.input.readText(file));
  const analysis = analyzeRustSymbols(parsed, file);
  for (const [key, table] of analysis.namespaces) build.namespaces.set(key, table);
  for (const declaration of analysis.declarations) {
    build.visibility.set(declaration.id, declaration.visibility);
  }
  for (const fn of analysis.functions) build.fnIds.set(fn.item, fn.id);
  return parsed;
}

function newNode(
  build: Build,
  init: {
    path: string;
    inline: boolean;
    file: string;
    scope: string;
    parent: RustModuleNode | null;
    public: boolean;
    block?: boolean;
  },
): RustModuleNode {
  return {
    ...init,
    block: init.block === true,
    children: new Map(),
    ambiguous: new Set(),
    tables: build.namespaces,
    visibility: build.visibility,
    imports: new Map(),
    globs: [],
  };
}

/** The scope a function's body resolves in: a block of its nested items when it has any, else its module (9.8). */
function bodyScope(
  build: Build,
  node: RustModuleNode,
  item: PendingFunction['item'],
  id: string,
): RustModuleNode {
  const nested = nestedItemsOf(item.body);
  if (nested.length === 0) return node;
  const block = newNode(build, {
    path: node.path,
    inline: false,
    file: node.file,
    scope: blockKey(id),
    parent: node,
    public: false,
    block: true,
  });
  visitItems(build, block, nested, '', [], true);
  return block;
}

/** The scope a function is owned by: its body's block when it has nested items, else the module. */
function fnOwner(
  build: Build,
  node: RustModuleNode,
  item: PendingFunction['item'],
): RustModuleNode {
  const id = build.fnIds.get(item);
  return id === undefined ? node : bodyScope(build, node, item, id);
}

function addFunction(
  build: Build,
  owner: RustModuleNode,
  item: PendingFunction['item'],
  container: PendingFunction['container'],
  blockAbi: string | null = null,
): void {
  const id = build.fnIds.get(item);
  if (id === undefined) return;
  const abi = item.qualifiers.abi ?? blockAbi;
  const noMangle = item.attrs.some((attr) => attr.path === 'no_mangle');
  build.functions.push({ owner, id, item, container, abi, noMangle });
}

/** The id of a named item in its module's own scope: values for consts and statics, types otherwise. */
function declIdOf(node: RustModuleNode, item: PendingDeclItem): string | undefined {
  const table = node.tables.get(node.scope);
  if (item.kind === 'const' || item.kind === 'static') {
    return item.name === '_' ? undefined : table?.value.get(item.name);
  }
  return table?.type.get(item.name);
}

function visitItems(
  build: Build,
  node: RustModuleNode,
  items: readonly Item[],
  inlinePath: string,
  inlineStack: readonly InlineModule[],
  modRs: boolean,
): void {
  for (const item of items) {
    if (item.kind === 'use') {
      for (const entry of flattenUse(item.tree, item.span)) {
        build.uses.push({ owner: node, entry, isPub: item.vis.kind !== 'private' });
      }
      continue;
    }
    if (item.kind === 'fn') {
      addFunction(build, fnOwner(build, node, item), item, null);
      continue;
    }
    if (item.kind === 'impl') {
      for (const child of item.items) {
        if (child.kind === 'fn') addFunction(build, fnOwner(build, node, child), child, item);
      }
      build.impls.push({
        owner: node,
        item,
        span: item.span,
        selfTy: item.selfTy,
        trait: item.trait,
        generics: item.generics.filter((g) => g.kind === 'type').map((g) => g.name),
      });
      continue;
    }
    if (item.kind === 'trait') {
      for (const child of item.items) {
        if (child.kind === 'fn') addFunction(build, fnOwner(build, node, child), child, item);
      }
      build.traits.push({
        owner: node,
        name: item.name,
        span: item.span,
        supertraits: item.supertraits,
      });
      continue;
    }
    if (item.kind === 'extern_block') {
      for (const child of item.items) {
        if (child.kind === 'fn') addFunction(build, node, child, null, item.abi);
      }
      continue;
    }
    if (
      item.kind === 'struct' ||
      item.kind === 'union' ||
      item.kind === 'enum' ||
      item.kind === 'type' ||
      item.kind === 'const' ||
      item.kind === 'static'
    ) {
      const id = declIdOf(node, item);
      if (id !== undefined) build.decls.push({ owner: node, id, item });
      continue;
    }
    if (item.kind !== 'mod') continue;
    const pathAttr = pathAttrOf(item.attrs);
    const literal = pathAttr.kind === 'literal' ? pathAttr.value : null;

    if (item.inline) {
      const childInline = inlinePath === '' ? item.name : `${inlinePath}::${item.name}`;
      const child = addChild(
        build,
        node,
        item.name,
        node.file,
        true,
        `${node.file}:${childInline}`,
        item.vis.kind === 'public',
      );
      visitItems(
        build,
        child,
        item.items,
        childInline,
        [...inlineStack, { name: item.name, pathAttr: literal }],
        modRs,
      );
      continue;
    }

    const candidates = moduleFileCandidates({
      file: node.file,
      modRs,
      inlineModules: inlineStack,
      pathAttr: literal,
      name: item.name,
    });
    const existing = candidates.filter((candidate) => build.input.files.has(candidate));
    const [childFile, ...others] = existing;
    if (childFile === undefined || others.length > 0) continue;

    const child = addChild(
      build,
      node,
      item.name,
      childFile,
      false,
      childFile,
      item.vis.kind === 'public',
    );
    if (child.file !== childFile || build.loaded.has(childFile)) continue;
    build.loaded.add(childFile);
    const childRoot = loadFile(build, childFile);
    visitItems(
      build,
      child,
      childRoot.items,
      '',
      [],
      isModRsFile(childFile, { crateRoot: false, loadedByPath: literal !== null }),
    );
  }
}

/** Adds a child module, or returns the existing one. A second declaration in another file is ambiguous. */
function addChild(
  build: Build,
  parent: RustModuleNode,
  name: string,
  file: string,
  inline: boolean,
  scope: string,
  isPub: boolean,
): RustModuleNode {
  const existing = parent.children.get(name);
  if (existing !== undefined) {
    if (existing.file !== file) parent.ambiguous.add(name);
    return existing;
  }
  const child = newNode(build, {
    path: parent.path === '' ? name : `${parent.path}::${name}`,
    inline,
    file,
    scope,
    parent,
    public: isPub,
  });
  parent.children.set(name, child);
  return child;
}
