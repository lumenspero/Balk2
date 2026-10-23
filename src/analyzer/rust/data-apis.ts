import { lookupDataApi } from '../../facts/data-catalog.js';
import { isDataPathLiteral } from '../../facts/path-value.js';
import type { DataReferenceFact } from '../../facts/types.js';
import type { SourceSpan } from '../../types.js';
import { parseRustFile, type Item } from './items.js';
import { lexRust, type RustToken } from './lexer.js';
import { flattenUse } from './names/use-tree.js';
import { buildTokenTrees, isTokenGroup, type TokenGroup, type TokenTree } from './token-tree.js';

/**
 * Data lineage for Rust (V3 Phase 11.3). A call whose full path resolves to a catalog API, with a
 * plain string literal as the artifact's argument, gives a data-reference fact. The path comes
 * from the token trees, so a call in any body is found. Names are resolved through the file's
 * top-level `use` items; a name with no `use` is taken as written, so only an absolute path such
 * as `std::fs::read` or a name imported with `use` can match. A `Path::new("x")` or
 * `PathBuf::from("x")` argument is read as its string.
 */

/** A call found in the token trees: the path it names and the group of its arguments. */
interface CallSite {
  readonly segments: readonly string[];
  readonly args: TokenGroup;
}

/** The data-reference facts of one Rust file, in source order. */
export function analyzeRustDataApis(filePath: string, source: string): DataReferenceFact[] {
  const { items } = parseRustFile(source);
  const uses = useTargets(items);
  const { trees } = buildTokenTrees(lexRust(source).tokens);

  const facts: DataReferenceFact[] = [];
  scanTrees(trees, (call) => facts.push(...factsOfCall(call, uses, filePath)));
  return facts;
}

/** The full path each name bound by a top-level `use` refers to, for plain (non-glob) entries. */
function useTargets(items: readonly Item[]): ReadonlyMap<string, readonly string[]> {
  const targets = new Map<string, readonly string[]>();
  for (const item of items) {
    if (item.kind !== 'use') continue;
    for (const entry of flattenUse(item.tree, item.span)) {
      if (entry.bind !== null && !entry.glob) targets.set(entry.bind, entry.path);
    }
  }
  return targets;
}

/** Finds every call in a token sequence, including calls inside groups. */
function scanTrees(trees: readonly TokenTree[], visit: (call: CallSite) => void): void {
  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i];
    if (tree === undefined) continue;
    if (isTokenGroup(tree)) {
      scanTrees(tree.children, visit);
      continue;
    }
    if (tree.kind !== 'ident' || isAfterDot(trees, i)) continue;

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
      visit({ segments, args: open });
    }
    i = next - 1;
  }
}

function isAfterDot(trees: readonly TokenTree[], i: number): boolean {
  return isPunct(trees[i - 1], '.');
}

function isPunct(tree: TokenTree | undefined, text: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'punct' && tree.text === text;
}

function isIdent(tree: TokenTree | undefined): tree is RustToken {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'ident';
}

/** The facts for one call: each argument the catalog names, with a literal path. */
function factsOfCall(
  call: CallSite,
  uses: ReadonlyMap<string, readonly string[]>,
  filePath: string,
): DataReferenceFact[] {
  const full = resolveSegments(call.segments, uses);
  const module = full.slice(0, -1).join('::');
  const name = full[full.length - 1] ?? '';
  if (module === '') return [];

  const facts: DataReferenceFact[] = [];
  splitArguments(call.args.children).forEach((tokens, index) => {
    const entry = lookupDataApi('rust', module, name, index);
    if (entry === undefined) return;
    const literal = pathLiteralOf(tokens);
    if (literal === undefined || !isDataPathLiteral(literal.value)) return;
    facts.push({
      kind: 'data-reference',
      filePath,
      span: sourceSpanOf(literal.token, filePath),
      path: literal.value,
      context: full.join('::'),
      api: { module: entry.module, name: entry.name, direction: entry.direction },
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

/**
 * The plain string literal an argument is: `"x"`, `&"x"`, `Path::new("x")`, `PathBuf::from("x")`.
 * Raw strings, byte strings and escapes are not paths this pass reads.
 */
function pathLiteralOf(
  tokens: readonly TokenTree[],
): { token: RustToken; value: string } | undefined {
  let rest = tokens;
  if (isPunct(rest[0], '&')) rest = rest.slice(1);

  if (rest.length === 1) {
    const only = rest[0];
    return only !== undefined && !isTokenGroup(only) ? plainString(only) : undefined;
  }

  // `Path::new(...)` or `PathBuf::from(...)` wrapping one string.
  const [owner, sep, ctor, args] = rest;
  const wrapped =
    isIdent(owner) &&
    (owner.value === 'Path' || owner.value === 'PathBuf') &&
    isPunct(sep, '::') &&
    isIdent(ctor) &&
    (ctor.value === 'new' || ctor.value === 'from') &&
    isTokenGroup(args as TokenTree) &&
    rest.length === 4;
  if (!wrapped) return undefined;
  const inner = (args as TokenGroup).children;
  return inner.length === 1 && inner[0] !== undefined && !isTokenGroup(inner[0])
    ? plainString(inner[0])
    : undefined;
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
