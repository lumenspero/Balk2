import { lookupDataApi } from '../../facts/data-catalog.js';
import { isDataPathLiteral } from '../../facts/path-value.js';
import type { DataApiMatch, DataReferenceFact } from '../../facts/types.js';
import type { SourceSpan } from '../../types.js';
import { parseRustFile } from './items.js';
import { lexRust, type RustToken } from './lexer.js';
import { flattenUse } from './names/use-tree.js';
import { buildTokenTrees, isTokenGroup, type TokenGroup, type TokenTree } from './token-tree.js';

/**
 * Data lineage for Rust (V3 Phase 11.3, with constants and scopes of 11.6). A call whose full path
 * resolves to a catalog API, with an argument that is a plain string literal, a `const` or `static`
 * holding one, or a `Path::new` or `PathBuf::from` wrapper of either, gives a data-reference fact.
 *
 * Names resolve through the `use` items and the `const`/`static` items of the enclosing blocks: the
 * file, an inline `mod`, or a function body. A `use crate::…` path to a constant in another file is
 * followed through `lookup`, and the fact then carries the declaring file so the path is placed from
 * there. `OpenOptions::new()` chains take their direction from their `write`-style flags.
 */

/** The value of a constant a path names, and the repository file that declares it. */
export interface RustConstant {
  readonly value: string;
  readonly declaringFile: string;
}

/**
 * A module of the crate: a file, and the inline modules inside it, by name. A file's own module has
 * no inline path (Phase 11.6).
 */
export interface ModulePosition {
  readonly file: string;
  readonly inline: readonly string[];
}

/**
 * Finds the constant a `use` path names, as written in the module `from`. The last segment is the
 * constant's name. Returns undefined when the path names no plain-string constant.
 */
export type RustConstantLookup = (
  from: ModulePosition,
  path: readonly string[],
) => RustConstant | undefined;

/**
 * The names a block makes visible: its `use` targets and plain-string constants, and the inline
 * module path it sits at. An inline module starts with no names of its enclosing module (Phase 11.6).
 */
interface Scope {
  readonly uses: ReadonlyMap<string, readonly string[]>;
  readonly consts: ReadonlyMap<string, string>;
  readonly module: readonly string[];
}

const EMPTY_SCOPE: Scope = { uses: new Map(), consts: new Map(), module: [] };

/** Flags of `OpenOptions` that make a chain a write when they are set to `true`. */
const WRITE_FLAGS: ReadonlySet<string> = new Set([
  'write',
  'append',
  'create',
  'create_new',
  'truncate',
]);

/** A call found in the token trees: the path it names, its argument group and its scope. */
interface CallSite {
  readonly segments: readonly string[];
  readonly args: TokenGroup;
  /** True for an `OpenOptions` chain with a write flag. */
  readonly writes: boolean;
  readonly scope: Scope;
}

/** The data-reference facts of one Rust file, in source order. */
export function analyzeRustDataApis(
  filePath: string,
  source: string,
  lookup?: RustConstantLookup,
): DataReferenceFact[] {
  const { trees } = buildTokenTrees(lexRust(source).tokens);
  const facts: DataReferenceFact[] = [];
  scanTrees(trees, EMPTY_SCOPE, (call) => facts.push(...factsOfCall(call, filePath, lookup)));
  return facts;
}

/** The plain-string constants a block declares directly, by name (Phase 11.6). */
export function constantsIn(trees: readonly TokenTree[]): ReadonlyMap<string, string> {
  return scopeOf(trees, EMPTY_SCOPE).consts;
}

/** The modules a block declares: inline modules with their contents, and file modules by name. */
export function moduleBlocks(trees: readonly TokenTree[]): {
  readonly inline: ReadonlyMap<string, readonly TokenTree[]>;
  readonly files: readonly string[];
} {
  const inline = new Map<string, readonly TokenTree[]>();
  const files: string[] = [];
  for (let i = 0; i < trees.length; i++) {
    const name = trees[i + 1];
    if (!isWord(trees[i], 'mod') || !isIdent(name)) continue;
    const after = trees[i + 2];
    if (isPunct(after, ';')) {
      files.push(name.value);
    } else if (after !== undefined && isTokenGroup(after) && after.delimiter === '{') {
      inline.set(name.value, after.children);
    }
  }
  return { inline, files };
}

/** The name of the inline module a group opens, when the group follows `mod name`. */
function inlineModuleNameBefore(trees: readonly TokenTree[], i: number): string | undefined {
  const name = trees[i - 1];
  return isIdent(name) && isWord(trees[i - 2], 'mod') ? name.value : undefined;
}

function isWord(tree: TokenTree | undefined, word: string): boolean {
  return (
    tree !== undefined &&
    !isTokenGroup(tree) &&
    tree.kind === 'ident' &&
    !tree.raw &&
    tree.value === word
  );
}

function isPunct(tree: TokenTree | undefined, text: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'punct' && tree.text === text;
}

function isIdent(tree: TokenTree | undefined): tree is RustToken {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'ident';
}

function isParenGroup(tree: TokenTree | undefined): tree is TokenGroup {
  return tree !== undefined && isTokenGroup(tree) && tree.delimiter === '(';
}

/** The source text of token trees, with groups written with their delimiters. */
function serialize(trees: readonly TokenTree[]): string {
  return trees
    .map((tree) =>
      isTokenGroup(tree)
        ? `${tree.open.text} ${serialize(tree.children)} ${tree.close?.text ?? ''}`
        : tree.text,
    )
    .join(' ');
}

/** The trees from a position up to, not including, the next `;` at the same level. */
function untilSemicolon(trees: readonly TokenTree[], start: number): TokenTree[] {
  const out: TokenTree[] = [];
  for (let k = start; k < trees.length && !isPunct(trees[k], ';'); k++) {
    const tree = trees[k];
    if (tree !== undefined) out.push(tree);
  }
  return out;
}

/** The names a `use` item at this index binds, each with the path it names, as written. */
function useBindingsAt(
  trees: readonly TokenTree[],
  useIndex: number,
): Map<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  const text = serialize(untilSemicolon(trees, useIndex + 1));
  for (const item of parseRustFile(`use ${text};`).items) {
    if (item.kind !== 'use') continue;
    for (const entry of flattenUse(item.tree, item.span)) {
      if (entry.bind !== null && !entry.glob) out.set(entry.bind, entry.path);
    }
  }
  return out;
}

/**
 * The `pub use` items of a block: the names it re-exports, each with the path it names (Phase 11.5).
 * A `pub(…)` restriction counts as public, which is an approximation for crate-wide visibility.
 */
export function publicUsesIn(trees: readonly TokenTree[]): ReadonlyMap<string, readonly string[]> {
  const out = new Map<string, readonly string[]>();
  for (let i = 0; i < trees.length; i++) {
    if (!isWord(trees[i], 'use') || !isPublicBefore(trees, i)) continue;
    for (const [name, target] of useBindingsAt(trees, i)) out.set(name, target);
  }
  return out;
}

/** True when the token before a `use` is `pub`, or a `pub(…)` restriction. */
function isPublicBefore(trees: readonly TokenTree[], useIndex: number): boolean {
  if (isWord(trees[useIndex - 1], 'pub')) return true;
  const before = trees[useIndex - 1];
  return before !== undefined && isTokenGroup(before) && isWord(trees[useIndex - 2], 'pub');
}

/**
 * The scope a block's token trees open: the `use` items and the plain-string `const`/`static` items
 * it declares, and the `let` bindings that give a name a plain string (Phase 11.5), on top of the
 * names it inherits. A `static mut` is not a constant, and a `mut` binding is not one either.
 */
function scopeOf(trees: readonly TokenTree[], inherited: Scope): Scope {
  // The module path is carried through; the names are gathered from this block's own items.
  const uses = new Map(inherited.uses);
  const consts = new Map(inherited.consts);
  for (let i = 0; i < trees.length; i++) {
    if (isWord(trees[i], 'use')) {
      for (const [name, target] of useBindingsAt(trees, i)) uses.set(name, target);
    }
    if (isWord(trees[i], 'const') || isWord(trees[i], 'static')) {
      const name = trees[i + 1];
      if (isIdent(name) && isPunct(trees[i + 2], ':')) {
        let k = i + 3;
        while (k < trees.length && !isPunct(trees[k], '=') && !isPunct(trees[k], ';')) k++;
        const value = trees[k + 1];
        if (isPunct(trees[k], '=') && value !== undefined && !isTokenGroup(value)) {
          const literal = plainString(value);
          if (literal !== undefined) consts.set(name.value, literal.value);
        }
      }
    }
  }
  // A `let` binds its name for the rest of the block. A name bound once, to a plain string that is
  // not `mut`, is a constant here. Any other binding of the name hides an outer constant.
  const lets = new Map<string, { count: number; literal: string | undefined; mutable: boolean }>();
  for (let i = 0; i < trees.length; i++) {
    if (!isWord(trees[i], 'let')) continue;
    const mutable = isWord(trees[i + 1], 'mut');
    const nameIndex = mutable ? i + 2 : i + 1;
    const name = trees[nameIndex];
    if (!isIdent(name)) continue;
    let k = nameIndex + 1;
    while (k < trees.length && !isPunct(trees[k], '=') && !isPunct(trees[k], ';')) k++;
    const value = trees[k + 1];
    const literal =
      isPunct(trees[k], '=') &&
      value !== undefined &&
      !isTokenGroup(value) &&
      isPunct(trees[k + 2], ';')
        ? plainString(value)?.value
        : undefined;
    const seen = lets.get(name.value) ?? { count: 0, literal: undefined, mutable: false };
    lets.set(name.value, {
      count: seen.count + 1,
      literal,
      mutable: seen.mutable || mutable,
    });
  }
  for (const [name, binding] of lets) {
    if (binding.count === 1 && !binding.mutable && binding.literal !== undefined) {
      consts.set(name, binding.literal);
    } else {
      consts.delete(name);
    }
  }
  return { uses, consts, module: inherited.module };
}

/** Finds every call in a token sequence, including calls inside groups, with the scope it is in. */
function scanTrees(
  trees: readonly TokenTree[],
  inherited: Scope,
  visit: (call: CallSite) => void,
): void {
  const scope = scopeOf(trees, inherited);
  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i];
    if (tree === undefined) continue;
    if (isTokenGroup(tree)) {
      // An inline module starts a scope of its own: the names of its parent are not visible in it.
      const inlineName = inlineModuleNameBefore(trees, i);
      const inner: Scope =
        inlineName === undefined
          ? scope
          : {
              uses: EMPTY_SCOPE.uses,
              consts: EMPTY_SCOPE.consts,
              module: [...scope.module, inlineName],
            };
      scanTrees(tree.children, inner, visit);
      continue;
    }
    if (tree.kind !== 'ident') continue;

    if (isPunct(trees[i - 1], '.')) {
      // A method call ends a chain: `OpenOptions::new().write(true).open(p)`, or
      // `csv::ReaderBuilder::new().delimiter(b',').from_path(p)`.
      const args = trees[i + 1];
      const chain = CHAINED_METHODS.has(tree.value)
        ? builderChain(trees, i, tree.value)
        : undefined;
      if (chain !== undefined && isParenGroup(args)) {
        visit({ segments: [...chain.root, tree.value], args, writes: chain.writes, scope });
      }
      continue;
    }

    // A path `a::b::c`, then a group `(` makes a call. Anything else is not a call.
    const segments = [tree.value];
    let next = i + 1;
    for (;;) {
      const separator = trees[next];
      const segment = trees[next + 1];
      if (!isPunct(separator, '::') || !isIdent(segment)) break;
      segments.push(segment.value);
      next += 2;
    }
    const open = trees[next];
    if (open !== undefined && isTokenGroup(open) && open.delimiter === '(') {
      visit({ segments, args: open, writes: false, scope });
    }
    i = next - 1;
  }
}

/** The methods a builder chain can end with, each on the builder its path names. */
const CHAINED_METHODS: ReadonlySet<string> = new Set(['open', 'from_path']);

/** Whether a `new()` or `options()` call on this owner starts a chain that ends with the method. */
function startsChain(method: string, previous: string, owner: string): boolean {
  if (method === 'open') {
    return (
      (previous === 'new' && owner === 'OpenOptions') ||
      (previous === 'options' && owner === 'File')
    );
  }
  return previous === 'new' && (owner === 'ReaderBuilder' || owner === 'WriterBuilder');
}

/**
 * The builder a chained method call is made on, as its path, and whether a chained flag makes it a
 * write. `OpenOptions::new().write(true).open(p)` and `csv::ReaderBuilder::new().from_path(p)` are
 * chains. Undefined when the receiver is not built by the `new()` or `options()` the method needs.
 */
function builderChain(
  trees: readonly TokenTree[],
  methodIndex: number,
  method: string,
): { root: string[]; writes: boolean } | undefined {
  let writes = false;
  let link = methodIndex;
  for (;;) {
    const dot = link - 1;
    if (!isPunct(trees[dot], '.')) return undefined;
    const receiverArgs = trees[dot - 1];
    const previous = trees[dot - 2];
    if (!isParenGroup(receiverArgs) || !isIdent(previous)) return undefined;

    if (isPunct(trees[dot - 3], '::')) {
      // The chain starts with a `new()` or `options()` call on a path.
      const root: string[] = [];
      for (let k = dot - 3; isPunct(trees[k], '::') && isIdent(trees[k - 1]); k -= 2) {
        root.unshift((trees[k - 1] as RustToken).value);
      }
      const owner = root[root.length - 1] ?? '';
      return startsChain(method, previous.value, owner) ? { root, writes } : undefined;
    }
    if (!isPunct(trees[dot - 3], '.')) return undefined;
    if (WRITE_FLAGS.has(previous.value) && isTrueArgument(receiverArgs)) writes = true;
    link = dot - 2;
  }
}

/** True for an argument list holding exactly the word `true`. */
function isTrueArgument(group: TokenGroup): boolean {
  return group.children.length === 1 && isWord(group.children[0], 'true');
}

/** The facts for one call: each argument the catalog names, with a path it holds. */
function factsOfCall(
  call: CallSite,
  filePath: string,
  lookup: RustConstantLookup | undefined,
): DataReferenceFact[] {
  const full = resolveSegments(call.segments, call.scope.uses);
  const module = full.slice(0, -1).join('::');
  const name = full[full.length - 1] ?? '';
  if (module === '') return [];

  const facts: DataReferenceFact[] = [];
  splitArguments(call.args.children).forEach((tokens, index) => {
    const entry = lookupDataApi('rust', module, name, index);
    if (entry === undefined) return;
    const literal = pathLiteralOf(tokens, call.scope, filePath, lookup);
    if (literal === undefined || !isDataPathLiteral(literal.value)) return;
    const direction: DataApiMatch['direction'] = call.writes ? 'generates' : entry.direction;
    facts.push({
      kind: 'data-reference',
      filePath,
      span: sourceSpanOf(literal.token, filePath),
      path: literal.value,
      context: full.join('::'),
      api: { module: entry.module, name: entry.name, direction },
      ...(literal.declaringFile === undefined || literal.declaringFile === filePath
        ? {}
        : { pathFilePath: literal.declaringFile }),
    });
  });
  return facts;
}

/** The full path a call names: its first segment replaced by its `use` target, when there is one. */
function resolveSegments(
  segments: readonly string[],
  uses: ReadonlyMap<string, readonly string[]>,
): string[] {
  const first = segments[0] ?? '';
  const target = uses.get(first);
  return target === undefined ? [...segments] : [...target, ...segments.slice(1)];
}

/** The arguments of a call, each as its own token list, split at top-level commas. */
function splitArguments(children: readonly TokenTree[]): TokenTree[][] {
  const args: TokenTree[][] = [];
  let current: TokenTree[] = [];
  for (const child of children) {
    if (isPunct(child, ',')) {
      args.push(current);
      current = [];
    } else {
      current.push(child);
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}

/** A path an argument holds: the token that names it, its value and the file that declares it. */
interface HeldPath {
  readonly token: RustToken;
  readonly value: string;
  readonly declaringFile?: string;
}

/**
 * The path an argument holds: `"x"`, `&"x"`, a `const` or `static` name with a plain string value,
 * or `Path::new(…)` / `PathBuf::from(…)` wrapping either. Raw strings, byte strings and escapes are
 * not paths this pass reads.
 */
function pathLiteralOf(
  tokens: readonly TokenTree[],
  scope: Scope,
  filePath: string,
  lookup: RustConstantLookup | undefined,
): HeldPath | undefined {
  let rest = tokens;
  if (isPunct(rest[0], '&')) rest = rest.slice(1);

  if (rest.length === 1) return valueOfArgument(rest[0], scope, filePath, lookup);

  // `Path::new(...)` or `PathBuf::from(...)` wrapping one path.
  const [owner, sep, ctor, args] = rest;
  const wrapped =
    isIdent(owner) &&
    (owner.value === 'Path' || owner.value === 'PathBuf') &&
    isPunct(sep, '::') &&
    isIdent(ctor) &&
    (ctor.value === 'new' || ctor.value === 'from') &&
    rest.length === 4 &&
    args !== undefined &&
    isTokenGroup(args);
  if (!wrapped) return undefined;
  const inner = (args as TokenGroup).children;
  return inner.length === 1 ? valueOfArgument(inner[0], scope, filePath, lookup) : undefined;
}

/** The path one argument token holds: a plain string, or a name of a constant it resolves to. */
function valueOfArgument(
  tree: TokenTree | undefined,
  scope: Scope,
  filePath: string,
  lookup: RustConstantLookup | undefined,
): HeldPath | undefined {
  if (tree === undefined || isTokenGroup(tree)) return undefined;
  if (tree.kind !== 'ident') return plainString(tree);

  const local = scope.consts.get(tree.value);
  if (local !== undefined) return { token: tree, value: local, declaringFile: filePath };
  const target = scope.uses.get(tree.value);
  if (target === undefined || target.length < 2 || lookup === undefined) return undefined;
  const found = lookup({ file: filePath, inline: scope.module }, target);
  return found === undefined
    ? undefined
    : { token: tree, value: found.value, declaringFile: found.declaringFile };
}

function plainString(token: RustToken): { token: RustToken; value: string } | undefined {
  if (token.kind !== 'str' || token.raw) return undefined;
  const match = /^"([^"\\]*)"$/.exec(token.text);
  return match?.[1] === undefined ? undefined : { token, value: match[1] };
}

function sourceSpanOf(token: RustToken, filePath: string): SourceSpan {
  return {
    filePath,
    startLine: token.line,
    startColumn: token.column,
    endLine: token.endLine,
    endColumn: token.endColumn,
  };
}
