import { type Attribute, type Item, parseRustFile } from '../items.js';
import type { RustToken } from '../lexer.js';
import type { TokenGroup, TokenTree } from '../token-tree.js';
import { type InlineModule, isModRsFile, moduleFileCandidates } from './paths.js';

/** A `declaresModule` edge: a module file declares a child module file (V3 Phase 8.3). */
export interface ModuleEdge {
  readonly from: string;
  readonly to: string;
  /**
   * The conditions on the declaration, including those of enclosing inline modules, as
   * `cfg(...)` predicates joined by ` and `. Null when unconditional. Conditions are kept as
   * text and never evaluated.
   */
  readonly cfg: string | null;
}

export interface ModuleTree {
  /** In discovery order: crate roots sorted by path, then declarations in source order */
  readonly edges: readonly ModuleEdge[];
  /** Every file a crate reaches, sorted */
  readonly files: readonly string[];
}

export interface ModuleTreeInput {
  /** Repository-relative crate root files (lib, bin, test, example, bench, build-script) */
  readonly crateRoots: readonly string[];
  /** Repository files, normalized to `/` separators */
  readonly files: ReadonlySet<string>;
  readonly readText: (path: string) => string;
}

interface Declaration {
  readonly name: string;
  readonly pathAttr: string | null;
  readonly inlineModules: readonly InlineModule[];
  readonly cfg: string | null;
}

interface Pending {
  readonly file: string;
  readonly modRs: boolean;
}

/**
 * Follows `mod name;` declarations from each crate root and returns one edge per declaration
 * whose target file exists. A declaration with no file, or with two candidate files (which Phase
 * 8.4 reports as `module-conflict`), draws no edge.
 *
 * Each file is parsed once, so cycles through `#[path]` terminate. The first path to reach a file
 * decides whether it is mod-rs. Files are visited in a fixed order, so the output is deterministic.
 */
export function buildModuleTree(input: ModuleTreeInput): ModuleTree {
  const visited = new Set<string>();
  const queue: Pending[] = [];
  const edges: ModuleEdge[] = [];

  const enqueue = (file: string, modRs: boolean): void => {
    if (visited.has(file) || !input.files.has(file)) return;
    visited.add(file);
    queue.push({ file, modRs });
  };

  for (const root of [...new Set(input.crateRoots)].sort()) {
    enqueue(root, isModRsFile(root, { crateRoot: true, loadedByPath: false }));
  }

  for (let next = 0; next < queue.length; next++) {
    const current = queue[next];
    if (current === undefined) break;
    const declarations: Declaration[] = [];
    collectDeclarations(parseRustFile(input.readText(current.file)).items, [], [], declarations);

    for (const declaration of declarations) {
      const candidates = moduleFileCandidates({
        file: current.file,
        modRs: current.modRs,
        inlineModules: declaration.inlineModules,
        pathAttr: declaration.pathAttr,
        name: declaration.name,
      }).filter((candidate) => input.files.has(candidate));
      const [child, ...others] = candidates;
      if (child === undefined || others.length > 0) continue;

      edges.push({ from: current.file, to: child, cfg: declaration.cfg });
      enqueue(
        child,
        isModRsFile(child, { crateRoot: false, loadedByPath: declaration.pathAttr !== null }),
      );
    }
  }

  return { edges, files: [...visited].sort() };
}

/** The `mod` declarations in a list of items, with the inline modules and `cfg`s around each. */
function collectDeclarations(
  items: readonly Item[],
  inlineModules: readonly InlineModule[],
  cfgs: readonly string[],
  out: Declaration[],
): void {
  for (const item of items) {
    if (item.kind !== 'mod') continue;
    const ownCfgs = [...cfgs, ...item.attrs.filter((attr) => attr.path === 'cfg').map(renderCfg)];
    const pathAttr = pathAttrOf(item.attrs);
    if (item.inline) {
      collectDeclarations(
        item.items,
        [...inlineModules, { name: item.name, pathAttr }],
        ownCfgs,
        out,
      );
      continue;
    }
    out.push({
      name: item.name,
      pathAttr,
      inlineModules,
      cfg: ownCfgs.length > 0 ? ownCfgs.join(' and ') : null,
    });
  }
}

/** A `cfg` attribute as text, such as `cfg(all(unix, not(test)))`. */
function renderCfg(attr: Attribute): string {
  return `cfg${renderTokens(attr.args)}`;
}

const CLOSERS: Readonly<Record<TokenGroup['delimiter'], string>> = { '(': ')', '[': ']', '{': '}' };

/** Token trees as text with canonical spacing: `, ` after commas, ` = ` around `=`. */
function renderTokens(trees: readonly TokenTree[]): string {
  let out = '';
  for (const tree of trees) {
    if (isGroup(tree)) {
      out += `${tree.delimiter}${renderTokens(tree.children)}${CLOSERS[tree.delimiter]}`;
    } else if (tree.kind === 'punct' && tree.text === ',') {
      out += ', ';
    } else if (tree.kind === 'punct' && tree.text === '=') {
      out += ' = ';
    } else {
      out += tree.text;
    }
  }
  return out;
}

/** The value of `#[path = "..."]`, or null when the attribute is absent or not a plain string. */
function pathAttrOf(attrs: readonly Attribute[]): string | null {
  const attr = attrs.find((candidate) => candidate.path === 'path');
  if (attr === undefined || attr.args.length !== 2) return null;
  const [equals, literal] = attr.args;
  if (equals === undefined || literal === undefined) return null;
  if (isGroup(equals) || equals.kind !== 'punct' || equals.text !== '=') return null;
  if (isGroup(literal)) return null;
  return stringValue(literal);
}

/** The contents of a string literal: plain (with `\\` and `\"` unescaped) or raw. */
function stringValue(token: RustToken): string | null {
  if (token.kind !== 'str') return null;
  if (token.raw) {
    const match = /^r(#*)"([\s\S]*)"\1$/.exec(token.text);
    return match?.[2] ?? null;
  }
  const text = token.text;
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) return null;
  return text.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

function isGroup(tree: TokenTree): tree is TokenGroup {
  return 'delimiter' in tree;
}
