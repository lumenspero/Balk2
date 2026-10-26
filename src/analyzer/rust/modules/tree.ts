import type { SourceSpan } from '../../../types.js';
import { type Attribute, type Item, type Span, parseRustFile } from '../items.js';
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

/** A `mod` declaration that cannot be connected to a file (V3 Phase 8.4, `unresolved-module-path`). */
export interface UnresolvedModule {
  /** The file that holds the declaration */
  readonly file: string;
  readonly location: SourceSpan;
  /** The module name, as written */
  readonly subject: string;
  readonly detail: string;
}

/** Two candidate files for one declaration (V3 Phase 8.4, `module-conflict`). */
export interface ModuleConflict {
  readonly file: string;
  readonly location: SourceSpan;
  readonly message: string;
}

/** The module tree of one crate root, as its own walk found it (V3 Phase 8.5, for the oracle). */
export interface CrateModules {
  readonly root: string;
  /** Sorted by source, then target, then cfg */
  readonly edges: readonly ModuleEdge[];
  /** The crate root and every file it reaches, sorted */
  readonly files: readonly string[];
}

export interface ModuleTree {
  /** One per declaration whose file exists, in discovery order; crates are visited in path order */
  readonly edges: readonly ModuleEdge[];
  /** Every file that some crate root reaches, sorted */
  readonly files: readonly string[];
  /** One entry per crate root that exists, sorted by root */
  readonly crates: readonly CrateModules[];
  /** Sorted by file, line and column */
  readonly unresolved: readonly UnresolvedModule[];
  /** Sorted by file, line and column */
  readonly conflicts: readonly ModuleConflict[];
  /** Rust files inside a Cargo package that no crate root reaches, sorted (`unreachable-module`) */
  readonly unreachable: readonly string[];
}

export interface ModuleTreeInput {
  /** Repository-relative crate root files (lib, bin, test, example, bench, build-script) */
  readonly crateRoots: readonly string[];
  /**
   * Repository-relative directories of the Cargo packages, `.` for the root. Rust files under
   * them are checked for reachability.
   */
  readonly packageDirs: readonly string[];
  /** Repository files, normalized to `/` separators */
  readonly files: ReadonlySet<string>;
  readonly readText: (path: string) => string;
  /** Macro names whose arguments are code (`rust.macros.expressionLike`). */
  readonly expressionMacros?: readonly string[];
}

/** The `#[path]` attribute of one declaration, as far as the map can use it. */
type PathAttr =
  | { readonly kind: 'absent' }
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'invalid'; readonly detail: string };

interface Declaration {
  readonly name: string;
  readonly location: SourceSpan;
  readonly path: PathAttr;
  readonly inlineModules: readonly InlineModule[];
  readonly cfg: string | null;
}

interface Pending {
  readonly file: string;
  readonly modRs: boolean;
}

/** The files and edges of the crate currently being walked. */
interface CrateSink {
  readonly reached: Set<string>;
  readonly edges: Map<string, ModuleEdge>;
}

interface Sink {
  readonly reached: Set<string>;
  readonly edges: Map<string, ModuleEdge>;
  readonly unresolved: Map<string, UnresolvedModule>;
  readonly conflicts: Map<string, ModuleConflict>;
  /** Candidate files of conflicting declarations, which `unreachable` must not repeat */
  readonly ambiguous: Set<string>;
}

/**
 * Follows `mod name;` declarations from each crate root.
 *
 * Each crate is walked on its own, with its own visited set, so a file that two crates reach is
 * resolved once per crate and the edges merge. Each file is parsed once per crate, so cycles
 * through `#[path]` terminate. A declaration draws an edge only when exactly one candidate file
 * exists. A missing file, a conflict, or a `#[path]` the map cannot evaluate is reported instead of
 * guessed.
 */
export function buildModuleTree(input: ModuleTreeInput): ModuleTree {
  const sink: Sink = {
    reached: new Set(),
    edges: new Map(),
    unresolved: new Map(),
    conflicts: new Map(),
    ambiguous: new Set(),
  };

  const crates: CrateModules[] = [];
  for (const root of [...new Set(input.crateRoots)].sort()) {
    if (!input.files.has(root)) continue;
    const crate: CrateSink = { reached: new Set(), edges: new Map() };
    walkCrate(root, input, sink, crate);
    crates.push({
      root,
      edges: sortEdges([...crate.edges.values()]),
      files: [...crate.reached].sort(),
    });
    for (const file of crate.reached) sink.reached.add(file);
    for (const [key, edge] of crate.edges) {
      if (!sink.edges.has(key)) sink.edges.set(key, edge);
    }
  }

  const unreachable = [...input.files]
    .filter(
      (file) =>
        file.endsWith('.rs') &&
        !sink.reached.has(file) &&
        !sink.ambiguous.has(file) &&
        input.packageDirs.some((dir) => dir === '.' || file.startsWith(`${dir}/`)),
    )
    .sort();

  return {
    edges: [...sink.edges.values()],
    files: [...sink.reached].sort(),
    crates,
    unresolved: sortByLocation([...sink.unresolved.values()]),
    conflicts: sortByLocation([...sink.conflicts.values()]),
    unreachable,
  };
}

function walkCrate(root: string, input: ModuleTreeInput, sink: Sink, crate: CrateSink): void {
  const queue: Pending[] = [];
  const enqueue = (file: string, modRs: boolean): void => {
    if (crate.reached.has(file) || !input.files.has(file)) return;
    crate.reached.add(file);
    queue.push({ file, modRs });
  };
  enqueue(root, true);

  for (let next = 0; next < queue.length; next++) {
    const current = queue[next];
    if (current === undefined) break;
    const declarations: Declaration[] = [];
    collectDeclarations(
      parseRustFile(input.readText(current.file), { expressionMacros: input.expressionMacros })
        .items,
      current.file,
      [],
      [],
      null,
      declarations,
    );
    for (const declaration of declarations) {
      resolveDeclaration(current, declaration, input, sink, crate, enqueue);
    }
  }
}

function resolveDeclaration(
  current: Pending,
  declaration: Declaration,
  input: ModuleTreeInput,
  sink: Sink,
  crate: CrateSink,
  enqueue: (file: string, modRs: boolean) => void,
): void {
  const unresolved = (detail: string): void => {
    const key = locationKey(declaration.location);
    if (sink.unresolved.has(key)) return;
    sink.unresolved.set(key, {
      file: current.file,
      location: declaration.location,
      subject: declaration.name,
      detail,
    });
  };

  if (declaration.path.kind === 'invalid') {
    unresolved(declaration.path.detail);
    return;
  }
  const pathAttr = declaration.path.kind === 'literal' ? declaration.path.value : null;
  const placed = moduleFileCandidates({
    file: current.file,
    modRs: current.modRs,
    inlineModules: declaration.inlineModules,
    pathAttr,
    name: declaration.name,
  });
  if (placed.length === 0) {
    unresolved('the #[path] is absolute, so it names no file in the repository');
    return;
  }

  const existing = placed.filter((candidate) => input.files.has(candidate));
  const [child, ...others] = existing;
  if (child === undefined) {
    unresolved(`no file at ${placed.join(' or ')}`);
    return;
  }
  if (others.length > 0) {
    for (const candidate of existing) sink.ambiguous.add(candidate);
    const key = locationKey(declaration.location);
    if (!sink.conflicts.has(key)) {
      sink.conflicts.set(key, {
        file: current.file,
        location: declaration.location,
        message: `both ${existing.join(' and ')} exist`,
      });
    }
    return;
  }

  const edgeKey = edgeId({ from: current.file, to: child, cfg: declaration.cfg });
  if (!crate.edges.has(edgeKey)) {
    crate.edges.set(edgeKey, { from: current.file, to: child, cfg: declaration.cfg });
  }
  enqueue(child, isModRsFile(child, { crateRoot: false, loadedByPath: pathAttr !== null }));
}

/**
 * The `mod` declarations in a list of items, with the inline modules and `cfg`s around each.
 * `blocked` is the detail of an enclosing inline module whose `#[path]` the map cannot evaluate.
 */
function collectDeclarations(
  items: readonly Item[],
  file: string,
  inlineModules: readonly InlineModule[],
  cfgs: readonly string[],
  blocked: string | null,
  out: Declaration[],
): void {
  for (const item of items) {
    if (item.kind !== 'mod') continue;
    const ownCfgs = [...cfgs, ...item.attrs.filter((attr) => attr.path === 'cfg').map(renderCfg)];
    const path = pathAttrOf(item.attrs);
    const location = locationOf(file, item.span);
    const innerBlocked = blocked ?? (path.kind === 'invalid' ? path.detail : null);
    if (item.inline) {
      const inlinePath = path.kind === 'literal' ? path.value : null;
      collectDeclarations(
        item.items,
        file,
        [...inlineModules, { name: item.name, pathAttr: inlinePath }],
        ownCfgs,
        innerBlocked,
        out,
      );
      continue;
    }
    out.push({
      name: item.name,
      location,
      path: blocked !== null ? { kind: 'invalid', detail: blocked } : path,
      inlineModules,
      cfg: ownCfgs.length > 0 ? ownCfgs.join(' and ') : null,
    });
  }
}

/** The `#[path]` attribute of an item, with a conditional or malformed one marked invalid. */
export function pathAttrOf(attrs: readonly Attribute[]): PathAttr {
  if (attrs.some((attr) => attr.path === 'cfg_attr' && containsIdent(attr.args, 'path'))) {
    return {
      kind: 'invalid',
      detail: 'the #[path] is set under #[cfg_attr], and conditions are not evaluated',
    };
  }
  const attr = attrs.find((candidate) => candidate.path === 'path');
  if (attr === undefined) return { kind: 'absent' };
  const [equals, literal] = attr.args;
  if (attr.args.length !== 2 || equals === undefined || literal === undefined) {
    return { kind: 'invalid', detail: '#[path] does not have a plain string value' };
  }
  if (isGroup(equals) || equals.kind !== 'punct' || equals.text !== '=' || isGroup(literal)) {
    return { kind: 'invalid', detail: '#[path] does not have a plain string value' };
  }
  const value = stringValue(literal);
  if (value === null) {
    return { kind: 'invalid', detail: '#[path] does not have a plain string value' };
  }
  return { kind: 'literal', value };
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

/** Whether an identifier appears anywhere in a token list, including nested groups. */
function containsIdent(trees: readonly TokenTree[], name: string): boolean {
  return trees.some((tree) =>
    isGroup(tree)
      ? containsIdent(tree.children, name)
      : tree.kind === 'ident' && tree.value === name,
  );
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

function locationOf(file: string, span: Span): SourceSpan {
  return {
    filePath: file,
    startLine: span.line,
    startColumn: span.column,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}

function edgeId(edge: ModuleEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.cfg ?? ''}`;
}

function sortEdges(edges: readonly ModuleEdge[]): ModuleEdge[] {
  return [...edges].sort(
    (a, b) =>
      compareText(a.from, b.from) ||
      compareText(a.to, b.to) ||
      compareText(a.cfg ?? '', b.cfg ?? ''),
  );
}

function locationKey(location: SourceSpan): string {
  return `${location.filePath}:${location.startLine}:${location.startColumn}`;
}

function sortByLocation<T extends { readonly location: SourceSpan }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      compareText(a.location.filePath, b.location.filePath) ||
      a.location.startLine - b.location.startLine ||
      a.location.startColumn - b.location.startColumn,
  );
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
