/**
 * The module tree of one Rust crate, with each module's namespace tables (V3 Phase 9.2).
 *
 * The root of the tree is the crate root file. A `mod name;` is a child whose items are in the
 * file that `moduleFileCandidates` finds (the Phase 8 rules, including `#[path]`). A `mod name { }`
 * is a child whose items are in the same file. Path resolution (names/resolve.ts) walks this tree
 * and reads each scope's names from `namespaces`.
 *
 * A child declared twice in the same file (`#[cfg(a)] mod x { }` and `#[cfg(b)] mod x { }`) is one
 * module whose items are both present. A child declared in two different files is ambiguous, and
 * names through it resolve to nothing. The module tree (Phase 8) already reports that conflict.
 */
import { parseRustFile, type Item, type RustFile } from '../items.js';
import { isModRsFile, moduleFileCandidates, type InlineModule } from '../modules/paths.js';
import { pathAttrOf } from '../modules/tree.js';
import { analyzeRustSymbols } from '../symbols.js';
import type { RustNamespaceTables } from './namespaces.js';

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
}

export interface RustCrateIndex {
  readonly root: RustModuleNode;
  /** Names of every scope in the crate's files, keyed by scope. */
  readonly namespaces: RustNamespaceTables;
  /** The crate's edition, such as `2015` or `2021`. */
  readonly edition: string;
  /** The `extern crate` items at the crate root, as local name to crate name. */
  readonly externCrates: ReadonlyMap<string, string>;
}

export interface CrateIndexInput {
  /** Repository-relative crate root file */
  readonly root: string;
  /** Repository-relative files, with `/` separators */
  readonly files: ReadonlySet<string>;
  readonly readText: (file: string) => string;
  readonly edition: string;
}

/** Builds the module tree and namespace tables of one crate. Missing or conflicting files are skipped. */
export function buildCrateIndex(input: CrateIndexInput): RustCrateIndex {
  const namespaces: RustNamespaceTables = new Map();
  const loaded = new Set<string>();

  const load = (file: string): RustFile => {
    const parsed = parseRustFile(input.readText(file));
    for (const [key, table] of analyzeRustSymbols(parsed, file).namespaces) {
      namespaces.set(key, table);
    }
    return parsed;
  };

  const root: RustModuleNode = {
    path: '',
    inline: false,
    file: input.root,
    scope: input.root,
    parent: null,
    children: new Map(),
    ambiguous: new Set(),
  };
  loaded.add(input.root);
  const rootFile = load(input.root);
  visitItems(root, input, rootFile.items, '', [], true, loaded, load);

  const externCrates = new Map<string, string>();
  for (const item of rootFile.items) {
    if (item.kind === 'extern_crate') externCrates.set(item.alias ?? item.name, item.name);
  }
  return { root, namespaces, edition: input.edition, externCrates };
}

function visitItems(
  node: RustModuleNode,
  input: CrateIndexInput,
  items: readonly Item[],
  inlinePath: string,
  inlineStack: readonly InlineModule[],
  modRs: boolean,
  loaded: Set<string>,
  load: (file: string) => RustFile,
): void {
  for (const item of items) {
    if (item.kind !== 'mod') continue;
    const pathAttr = pathAttrOf(item.attrs);
    const literal = pathAttr.kind === 'literal' ? pathAttr.value : null;

    if (item.inline) {
      const childInline = inlinePath === '' ? item.name : `${inlinePath}::${item.name}`;
      const child = addChild(node, item.name, node.file, true, `${node.file}:${childInline}`);
      visitItems(
        child,
        input,
        item.items,
        childInline,
        [...inlineStack, { name: item.name, pathAttr: literal }],
        modRs,
        loaded,
        load,
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
    const existing = candidates.filter((candidate) => input.files.has(candidate));
    const [childFile, ...others] = existing;
    if (childFile === undefined || others.length > 0) continue;

    const child = addChild(node, item.name, childFile, false, childFile);
    if (child.file !== childFile || loaded.has(childFile)) continue;
    loaded.add(childFile);
    visitItems(
      child,
      input,
      load(childFile).items,
      '',
      [],
      isModRsFile(childFile, { crateRoot: false, loadedByPath: literal !== null }),
      loaded,
      load,
    );
  }
}

/** Adds a child module, or returns the existing one. A second declaration in another file is ambiguous. */
function addChild(
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
  const child: RustModuleNode = {
    path: parent.path === '' ? name : `${parent.path}::${name}`,
    inline,
    file,
    scope,
    parent,
    children: new Map(),
    ambiguous: new Set(),
  };
  parent.children.set(name, child);
  return child;
}
