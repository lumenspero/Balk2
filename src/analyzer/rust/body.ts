/**
 * Function body scanning (V3 Phase 6.4, part a: calls, method calls, macro invocations,
 * path references and nested items).
 *
 * The scan works on the token trees of a body. It reports only what the tokens show and
 * never evaluates anything. A keyword is never a path head, so `if (x)` gives a reference
 * to `x`, not a call. Nested items are skipped as whole statements, and their bodies are
 * left for their own scan. Let bindings, patterns, closures and struct literals come in
 * the next parts. Until then, a `let` pattern appears as path references.
 *
 * Positions are 1-based, as in the lexer.
 */

import type { Span } from './items.js';
import { isKeyword, type RustToken } from './lexer.js';
import { isTokenGroup, type TokenGroup, type TokenTree } from './token-tree.js';

export type BodyFact =
  | {
      readonly kind: 'call';
      /** The callee path, for example `['Vec', 'new']`. */
      readonly path: readonly string[];
      readonly args: TokenGroup;
      readonly span: Span;
    }
  | {
      readonly kind: 'method-call';
      readonly method: string;
      readonly args: TokenGroup;
      readonly span: Span;
    }
  | {
      /** The tokens are not scanned here. Expression macros are parsed in Phase 10. */
      readonly kind: 'macro-call';
      readonly path: readonly string[];
      readonly args: TokenGroup;
      readonly span: Span;
    }
  | { readonly kind: 'path'; readonly segments: readonly string[]; readonly span: Span }
  | { readonly kind: 'item'; readonly keyword: string; readonly span: Span };

/** Keywords that can head a path. */
const PATH_KEYWORDS: ReadonlySet<string> = new Set(['self', 'Self', 'super', 'crate']);

/** Keywords that start an item statement, which is skipped whole. */
const ITEM_KEYWORDS: ReadonlySet<string> = new Set([
  'enum',
  'extern',
  'fn',
  'impl',
  'mod',
  'struct',
  'trait',
  'type',
  'use',
]);

const ANGLE_DELTA: Readonly<Record<string, number>> = { '<': 1, '<<': 2, '>': -1, '>>': -2 };

function isPunct(tree: TokenTree | undefined, text: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'punct' && tree.text === text;
}

function groupOf(tree: TokenTree | undefined, delimiter: string): TokenGroup | undefined {
  return tree !== undefined && isTokenGroup(tree) && tree.delimiter === delimiter
    ? tree
    : undefined;
}

/** The delimited group at `index`, whatever its delimiter. */
function anyGroupAt(trees: readonly TokenTree[], index: number): TokenGroup | undefined {
  const tree = trees[index];
  return tree !== undefined && isTokenGroup(tree) ? tree : undefined;
}

function identToken(tree: TokenTree | undefined): RustToken | undefined {
  if (tree === undefined || isTokenGroup(tree) || tree.kind !== 'ident') return undefined;
  return tree;
}

/** A path segment at `index`. A keyword is a segment only when it is in PATH_KEYWORDS. */
function pathSegmentAt(trees: readonly TokenTree[], index: number): string | undefined {
  const token = identToken(trees[index]);
  if (token === undefined) return undefined;
  if (isKeyword(token) && !PATH_KEYWORDS.has(token.value)) return undefined;
  return token.value;
}

function angleDelta(tree: TokenTree): number {
  if (isTokenGroup(tree) || tree.kind !== 'punct') return 0;
  return ANGLE_DELTA[tree.text] ?? 0;
}

/** Skips a turbofish list. `start` is the `<`. Returns the index after the matching `>`. */
function skipAngle(trees: readonly TokenTree[], start: number): number {
  let depth = 0;
  for (let k = start; k < trees.length; k += 1) {
    const tree = trees[k];
    if (tree === undefined) break;
    depth += angleDelta(tree);
    if (depth <= 0) return k + 1;
  }
  return trees.length;
}

/** Reads a path such as `a::b::<T>::c` from `start`. Returns its segments and the index after it. */
function readPath(
  trees: readonly TokenTree[],
  start: number,
): { segments: string[]; end: number } | undefined {
  let i = start;
  if (isPunct(trees[i], '::')) i += 1;
  const first = pathSegmentAt(trees, i);
  if (first === undefined) return undefined;
  const segments = [first];
  i += 1;
  while (isPunct(trees[i], '::')) {
    if (isPunct(trees[i + 1], '<')) {
      i = skipAngle(trees, i + 1);
      continue;
    }
    const next = pathSegmentAt(trees, i + 1);
    if (next === undefined) break;
    segments.push(next);
    i += 2;
  }
  return { segments, end: i };
}

function spanBetween(first: TokenTree, last: TokenTree): Span {
  return {
    line: first.line,
    column: first.column,
    endLine: last.endLine,
    endColumn: last.endColumn,
  };
}

/** The span of `trees[from..to)`. `to` must be greater than `from`. */
function spanOfRange(trees: readonly TokenTree[], from: number, to: number): Span {
  const first = trees[from];
  const last = trees[to - 1];
  if (first === undefined || last === undefined) {
    return { line: 1, column: 1, endLine: 1, endColumn: 1 };
  }
  return spanBetween(first, last);
}

/** Skips an item statement: up to a `;`, or through a `{ … }` body. Returns the index after it. */
function skipItem(trees: readonly TokenTree[], start: number): number {
  let j = start;
  while (j < trees.length) {
    const tree = trees[j];
    j += 1;
    if (tree !== undefined && (isPunct(tree, ';') || groupOf(tree, '{') !== undefined)) break;
  }
  return j;
}

/** A field access or method call after `.`. Returns the index to continue from. */
function scanAfterDot(trees: readonly TokenTree[], dotIndex: number, facts: BodyFact[]): number {
  const dot = trees[dotIndex];
  const name = identToken(trees[dotIndex + 1]);
  if (dot === undefined || name === undefined) return dotIndex + 1;

  let j = dotIndex + 2;
  if (isPunct(trees[j], '::') && isPunct(trees[j + 1], '<')) j = skipAngle(trees, j + 1);
  const args = groupOf(trees[j], '(');
  if (args === undefined) return dotIndex + 2; // a field, or a tuple index such as `.0`
  facts.push({ kind: 'method-call', method: name.value, args, span: spanBetween(dot, args) });
  return j;
}

/** Facts for a list of token trees, in source order. Groups are scanned recursively. */
export function scanTokens(trees: readonly TokenTree[]): BodyFact[] {
  const facts: BodyFact[] = [];
  let i = 0;
  while (i < trees.length) {
    const tree = trees[i];
    if (tree === undefined) break;

    if (isTokenGroup(tree)) {
      for (const fact of scanTokens(tree.children)) facts.push(fact);
      i += 1;
      continue;
    }
    if (isPunct(tree, '.')) {
      i = scanAfterDot(trees, i, facts);
      continue;
    }

    const token = identToken(tree);
    if (token !== undefined && isKeyword(token) && ITEM_KEYWORDS.has(token.value)) {
      const end = skipItem(trees, i);
      facts.push({ kind: 'item', keyword: token.value, span: spanOfRange(trees, i, end) });
      i = end;
      continue;
    }

    const path = readPath(trees, i);
    if (path === undefined) {
      i += 1;
      continue;
    }
    const after = trees[path.end];
    const macroArgs = isPunct(after, '!') ? anyGroupAt(trees, path.end + 1) : undefined;
    if (macroArgs !== undefined) {
      facts.push({
        kind: 'macro-call',
        path: path.segments,
        args: macroArgs,
        span: spanOfRange(trees, i, path.end + 2),
      });
      i = path.end + 2;
      continue;
    }
    const args = groupOf(after, '(');
    if (args !== undefined) {
      facts.push({ kind: 'call', path: path.segments, args, span: spanBetween(tree, args) });
      i = path.end;
      continue;
    }
    facts.push({
      kind: 'path',
      segments: path.segments,
      span: spanOfRange(trees, i, path.end),
    });
    i = path.end;
  }
  return facts;
}

/** Facts for one function body, as returned by `parseRustFile` in `FnItem.body`. */
export function scanFunctionBody(body: TokenGroup): BodyFact[] {
  return scanTokens(body.children);
}
