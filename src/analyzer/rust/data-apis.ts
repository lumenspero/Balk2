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

/** Finds the constant a `use` path names in another file of the crate, or undefined. */
export type RustConstantLookup = (
  modulePath: readonly string[],
  name: string,
) => RustConstant | undefined;

/** The names a block makes visible: its `use` targets, and its plain-string constants. */
interface Scope {
  readonly uses: ReadonlyMap<string, readonly string[]>;
  readonly consts: ReadonlyMap<string, string>;
}

const EMPTY_SCOPE: Scope = { uses: new Map(), consts: new Map() };

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

/** The plain-string constants a file declares at its top level, by name (Phase 11.6). */
export function rustConstantsOf(source: string): ReadonlyMap<string, string> {
  const { trees } = buildTokenTrees(lexRust(source).tokens);
  return scopeOf(trees, EMPTY_SCOPE).consts;
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

/**
 * The scope a block's token trees open: the `use` items and the plain-string `const`/`static` items
 * it declares, on top of the names it inherits. A `static mut` is not a constant.
 */
function scopeOf(trees: readonly TokenTree[], inherited: Scope): Scope {
  const uses = new Map(inherited.uses);
  const consts = new Map(inherited.consts);
  for (let i = 0; i < trees.length; i++) {
    if (isWord(trees[i], 'use')) {
      const text = serialize(untilSemicolon(trees, i + 1));
      for (const item of parseRustFile(`use ${text};`).items) {
        if (item.kind !== 'use') continue;
        for (const entry of flattenUse(item.tree, item.span)) {
          if (entry.bind !== null && !entry.glob) uses.set(entry.bind, entry.path);
        }
      }
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
  return { uses, consts };
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
      scanTrees(tree.children, scope, visit);
      continue;
    }
    if (tree.kind !== 'ident') continue;

    if (isPunct(trees[i - 1], '.')) {
      // A method call ends a chain: `OpenOptions::new().write(true).open(p)`.
      const args = trees[i + 1];
      const chain = tree.value === 'open' ? openChain(trees, i) : undefined;
      if (chain !== undefined && isParenGroup(args)) {
        visit({ segments: [...chain.root, 'open'], args, writes: chain.writes, scope });
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

/**
 * The `OpenOptions::new()` a `.open(…)` call is chained onto, as its path, and whether a chained
 * flag makes it a write. Undefined when the receiver is not an `OpenOptions` built with `new()`.
 */
function openChain(
  trees: readonly TokenTree[],
  openIndex: number,
): { root: string[]; writes: boolean } | undefined {
  let writes = false;
  let method = openIndex;
  for (;;) {
    const dot = method - 1;
    if (!isPunct(trees[dot], '.')) return undefined;
    const receiverArgs = trees[dot - 1];
    const previous = trees[dot - 2];
    if (!isParenGroup(receiverArgs) || !isIdent(previous)) return undefined;

    if (isPunct(trees[dot - 3], '::')) {
      // The chain starts with `OpenOptions::new()` or `File::options()`.
      const root: string[] = [];
      for (let k = dot - 3; isPunct(trees[k], '::') && isIdent(trees[k - 1]); k -= 2) {
        root.unshift((trees[k - 1] as RustToken).value);
      }
      const owner = root[root.length - 1];
      const builds =
        (previous.value === 'new' && owner === 'OpenOptions') ||
        (previous.value === 'options' && owner === 'File');
      return builds ? { root, writes } : undefined;
    }
    if (!isPunct(trees[dot - 3], '.')) return undefined;
    if (WRITE_FLAGS.has(previous.value) && isTrueArgument(receiverArgs)) writes = true;
    method = dot - 2;
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
  const found = lookup(target.slice(0, -1), target[target.length - 1] ?? '');
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
