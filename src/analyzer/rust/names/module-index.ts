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
import { parseRustFile, type Item, type RustFile } from '../items.js';
import { isModRsFile, moduleFileCandidates, type InlineModule } from '../modules/paths.js';
import { pathAttrOf } from '../modules/tree.js';
import type { RustNamespace, RustNamespaceTables } from './namespaces.js';
import { analyzeRustSymbols } from '../symbols.js';
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
  readonly globs: GlobBinding[];
}

/** A `use` entry that has not been bound yet, with the module it is written in. */
export interface PendingUse {
  readonly owner: RustModuleNode;
  readonly entry: UseEntry;
  readonly isPub: boolean;
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
  readonly loaded: Set<string>;
}

/** Builds the module tree, namespace tables and pending `use` entries of one crate. */
export function buildCrateIndex(input: CrateIndexInput): RustCrateIndex {
  const build: Build = {
    input,
    namespaces: new Map(),
    visibility: new Map(),
    uses: [],
    loaded: new Set([input.root]),
  };
  const rootFile = loadFile(build, input.root);
  const root = newNode(build, {
    path: '',
    inline: false,
    file: input.root,
    scope: input.root,
    parent: null,
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
  };
}

function loadFile(build: Build, file: string): RustFile {
  const parsed = parseRustFile(build.input.readText(file));
  const analysis = analyzeRustSymbols(parsed, file);
  for (const [key, table] of analysis.namespaces) build.namespaces.set(key, table);
  for (const declaration of analysis.declarations) {
    build.visibility.set(declaration.id, declaration.visibility);
  }
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
  },
): RustModuleNode {
  return {
    ...init,
    children: new Map(),
    ambiguous: new Set(),
    tables: build.namespaces,
    visibility: build.visibility,
    imports: new Map(),
    globs: [],
  };
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

    const child = addChild(build, node, item.name, childFile, false, childFile);
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
  });
  parent.children.set(name, child);
  return child;
}
