/**
 * Function body scanning (V3 Phase 6.4).
 *
 * Part a: calls, method calls, macro invocations, path references and nested items.
 * Part b: bindings from `let`, `for`, `if let`, `while let`, closure parameters and match arms.
 *
 * The scan works on the token trees of a body. It reports only what the tokens show and never
 * evaluates anything. A keyword is never a path head, so `if (x)` gives a reference to `x`,
 * not a call. Nested items are skipped as whole statements; their bodies get their own scan.
 * Macro arguments: the arguments of the built-in expression-style macros are scanned like a body,
 * and the first argument of `matches!` (V3 Phase 10.2). Other macros' tokens are not scanned, since
 * their syntax is not known. Struct literals come in part c.
 *
 * Positions are 1-based, as in the lexer.
 */

import type { Fragment, Span } from './items.js';
import { isKeyword, type RustToken } from './lexer.js';
import { isTokenGroup, type TokenGroup, type TokenTree } from './token-tree.js';

export interface Binding {
  readonly name: string;
  readonly span: Span;
}

/** One field of a struct literal. `shorthand` is `Foo { name }`, where the value is the local `name`. */
export interface StructField {
  readonly name: string;
  readonly shorthand: boolean;
  readonly span: Span;
}

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
      /** The receiver when it is a plain name or `self`, as in `x` in `x.m()`. Null otherwise. */
      readonly receiver: string | null;
      readonly args: TokenGroup;
      readonly span: Span;
      /** The call this one is made on, when the receiver is `name.m(args)`, as in `map.entry(k).or_insert(v)`. */
      readonly receiverCall?: ChainedCall;
    }
  | {
      readonly kind: 'macro-call';
      readonly path: readonly string[];
      readonly args: TokenGroup;
      readonly span: Span;
    }
  | { readonly kind: 'path'; readonly segments: readonly string[]; readonly span: Span }
  | { readonly kind: 'item'; readonly keyword: string; readonly span: Span }
  | {
      /** `let`, and also `if let` and `while let`. `type` is the annotation, if any. */
      readonly kind: 'let';
      readonly bindings: readonly Binding[];
      readonly type: Fragment | null;
      readonly hasInit: boolean;
      /** True when the pattern is one plain name, as in `let x` or `let mut x`. */
      readonly simple: boolean;
      /** The initializer tokens, when there is one. They are scanned as their own facts too. */
      readonly init: readonly TokenTree[] | null;
      readonly span: Span;
    }
  | { readonly kind: 'for'; readonly bindings: readonly Binding[]; readonly span: Span }
  | { readonly kind: 'closure'; readonly params: readonly Binding[]; readonly span: Span }
  | { readonly kind: 'match-arm'; readonly bindings: readonly Binding[]; readonly span: Span }
  | {
      /** `Path { field: value, shorthand, ..base }`. The values are scanned as their own facts. */
      readonly kind: 'struct-literal';
      readonly path: readonly string[];
      readonly fields: readonly StructField[];
      readonly span: Span;
    };

/** A call made on a plain name, such as `map.entry(k)` in `map.entry(k).or_insert(v)`. */
export interface ChainedCall {
  readonly receiver: string;
  readonly method: string;
  readonly args: TokenGroup;
}

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

/**
 * Built-in macros whose arguments are all expressions (V3 Phase 10.2). Matched by the last path
 * segment, so `std::println!` counts. `rust.macros.expressionLike` (config, Phase 15.3) adds more.
 */
const EXPRESSION_MACROS: ReadonlySet<string> = new Set([
  'format',
  'print',
  'println',
  'eprint',
  'eprintln',
  'write',
  'writeln',
  'panic',
  'assert',
  'assert_eq',
  'assert_ne',
  'debug_assert',
  'debug_assert_eq',
  'debug_assert_ne',
  'vec',
  'dbg',
  'todo',
  'unreachable',
]);

/** Macros whose first argument is an expression and whose later arguments are patterns. */
const FIRST_ARGUMENT_MACROS: ReadonlySet<string> = new Set(['matches']);

/**
 * True when a macro's arguments are code. Any other macro's arguments are template or token text, such as a
 * `quote!` body, so they declare nothing and name nothing.
 */
export function macroArgumentsAreCode(name: string, args?: TokenGroup): boolean {
  return (
    EXPRESSION_MACROS.has(name) || FIRST_ARGUMENT_MACROS.has(name) || args?.codeArguments === true
  );
}

/** The token trees of a macro's arguments that are expressions, to scan like a body (V3 Phase 10.2). */
function expressionArgsOf(name: string, args: TokenGroup): readonly TokenTree[] {
  if (EXPRESSION_MACROS.has(name) || args.codeArguments === true) return args.children;
  if (FIRST_ARGUMENT_MACROS.has(name)) return splitTopLevel(args.children, ',')[0] ?? [];
  return [];
}

function isPunct(tree: TokenTree | undefined, text: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'punct' && tree.text === text;
}

/** True for an identifier token with exactly this text (a keyword such as `in`). */
function isWord(tree: TokenTree | undefined, word: string): boolean {
  return (
    tree !== undefined &&
    !isTokenGroup(tree) &&
    tree.kind === 'ident' &&
    !tree.raw &&
    tree.value === word
  );
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

function spanOfToken(token: RustToken): Span {
  return {
    line: token.line,
    column: token.column,
    endLine: token.endLine,
    endColumn: token.endColumn,
  };
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

function renderTree(tree: TokenTree): string {
  if (!isTokenGroup(tree)) return tree.text;
  return `${tree.open.text}${tree.children.map(renderTree).join(' ')}${tree.close?.text ?? ''}`;
}

function fragmentOf(trees: readonly TokenTree[]): Fragment {
  return { raw: trees.map(renderTree).join(' '), tokens: trees };
}

/** The first index in [from, to) whose token matches. Plain search, with no depth tracking. */
function indexWhere(
  trees: readonly TokenTree[],
  from: number,
  to: number,
  matches: (tree: TokenTree) => boolean,
): number {
  for (let k = from; k < to; k += 1) {
    const tree = trees[k];
    if (tree !== undefined && matches(tree)) return k;
  }
  return -1;
}

/** Like indexWhere, but only at angle-bracket depth zero, so `Item = u8` inside `<…>` is skipped. */
function indexWhereTopLevel(
  trees: readonly TokenTree[],
  from: number,
  to: number,
  matches: (tree: TokenTree) => boolean,
): number {
  let depth = 0;
  for (let k = from; k < to; k += 1) {
    const tree = trees[k];
    if (tree === undefined) break;
    if (depth === 0 && matches(tree)) return k;
    depth = Math.max(0, depth + angleDelta(tree));
  }
  return -1;
}

/** Splits on a separator at angle depth zero. A group is one tree, so its contents never split. */
function splitTopLevel(trees: readonly TokenTree[], separator: string): TokenTree[][] {
  const out: TokenTree[][] = [[]];
  let depth = 0;
  for (const tree of trees) {
    if (depth === 0 && isPunct(tree, separator)) {
      out.push([]);
      continue;
    }
    depth = Math.max(0, depth + angleDelta(tree));
    out.at(-1)?.push(tree);
  }
  return out;
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

/** The call before a method call's dot, when it is `name.m(args)`. Only a plain name is read. */
function chainedCallOf(trees: readonly TokenTree[], dotIndex: number): ChainedCall | undefined {
  const args = groupOf(trees[dotIndex - 1], '(');
  const method = identToken(trees[dotIndex - 2]);
  const receiver = identToken(trees[dotIndex - 4]);
  if (args === undefined || method === undefined || receiver === undefined) return undefined;
  if (!isPunct(trees[dotIndex - 3], '.')) return undefined;
  if (isPunct(trees[dotIndex - 5], '.') || isPunct(trees[dotIndex - 5], '::')) return undefined;
  return { receiver: receiver.value, method: method.value, args };
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
  const before = trees[dotIndex - 1];
  const beforeBefore = trees[dotIndex - 2];
  const plain =
    !isPunct(beforeBefore, '.') && !isPunct(beforeBefore, '::') ? identToken(before) : undefined;
  const chained = chainedCallOf(trees, dotIndex);
  facts.push({
    kind: 'method-call',
    method: name.value,
    receiver: plain?.value ?? null,
    args,
    span: spanBetween(dot, args),
    ...(chained !== undefined ? { receiverCall: chained } : {}),
  });
  return j;
}

// ── Patterns ────────────────────────────────────────────────

/**
 * Names that a pattern binds. Uppercase names are constants or unit variants, and a path head
 * (`Foo::Bar`, `Foo(…)`, `Foo { … }`) is not a binding. In a struct pattern, a field name before
 * `:` is skipped, and the pattern after the colon binds.
 */
function patternBindings(trees: readonly TokenTree[]): Binding[] {
  const out: Binding[] = [];
  for (let i = 0; i < trees.length; i += 1) {
    const tree = trees[i];
    if (tree === undefined) continue;
    if (isTokenGroup(tree)) {
      for (const binding of patternBindings(tree.children)) out.push(binding);
      continue;
    }
    const token = identToken(tree);
    if (token === undefined || isKeyword(token) || token.value === '_') continue;

    let last = i;
    while (isPunct(trees[last + 1], '::') && identToken(trees[last + 2]) !== undefined) last += 2;
    const next = trees[last + 1];
    if (
      last > i ||
      isPunct(next, '!') ||
      groupOf(next, '(') !== undefined ||
      groupOf(next, '{') !== undefined
    ) {
      i = last;
      continue;
    }
    if (isPunct(next, ':')) continue;
    if (/^[A-Z]/.test(token.value)) continue;
    out.push({ name: token.value, span: spanOfToken(token) });
  }
  return out;
}

// ── Statements that bind ────────────────────────────────────

/** A pattern's tokens without `mut` and `ref`, which do not change what it binds. */
function patternTokens(trees: readonly TokenTree[]): TokenTree[] {
  return trees.filter((t) => !isWordTree(t, 'mut') && !isWordTree(t, 'ref'));
}

function isWordTree(tree: TokenTree | undefined, word: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'ident' && tree.value === word;
}

/** The index where a `let` initializer ends: its top-level `;`, or the end of the list. */
function initEnd(trees: readonly TokenTree[], from: number): number {
  const end = indexWhereTopLevel(trees, from, trees.length, (t) => isPunct(t, ';'));
  return end < 0 ? trees.length : end;
}

/** `let PAT (: TYPE)? (= INIT)?`. The pattern and type are not scanned as expressions. */
function scanLet(trees: readonly TokenTree[], i: number, facts: BodyFact[]): number {
  const end = indexWhereTopLevel(
    trees,
    i + 1,
    trees.length,
    (t) => isPunct(t, '=') || isPunct(t, ';') || isPunct(t, ':'),
  );
  const patternEnd = end < 0 ? trees.length : end;
  const bindings = patternBindings(trees.slice(i + 1, patternEnd));

  let k = patternEnd;
  let type: Fragment | null = null;
  if (isPunct(trees[k], ':')) {
    const typeEnd = indexWhereTopLevel(
      trees,
      k + 1,
      trees.length,
      (t) => isPunct(t, '=') || isPunct(t, ';'),
    );
    const stop = typeEnd < 0 ? trees.length : typeEnd;
    type = fragmentOf(trees.slice(k + 1, stop));
    k = stop;
  }
  facts.push({
    kind: 'let',
    bindings,
    type,
    hasInit: isPunct(trees[k], '='),
    simple:
      patternTokens(trees.slice(i + 1, patternEnd)).length === 1 &&
      identToken(patternTokens(trees.slice(i + 1, patternEnd))[0]) !== undefined,
    init: isPunct(trees[k], '=') ? trees.slice(k + 1, initEnd(trees, k + 1)) : null,
    span: spanOfRange(trees, i, k),
  });
  return k;
}

/** `for PAT in EXPR BLOCK`. The expression that follows `in` is scanned normally. */
function scanFor(trees: readonly TokenTree[], i: number, facts: BodyFact[]): number {
  const inAt = indexWhere(trees, i + 1, trees.length, (t) => isWord(t, 'in'));
  if (inAt < 0) return i + 1;
  facts.push({
    kind: 'for',
    bindings: patternBindings(trees.slice(i + 1, inAt)),
    span: spanOfRange(trees, i, inAt + 1),
  });
  return scanHeader(trees, inAt + 1, facts);
}

/** Match arms: `PAT (if GUARD)? => BODY ,?`. */
function scanMatchArms(trees: readonly TokenTree[]): BodyFact[] {
  const facts: BodyFact[] = [];
  let i = 0;
  while (i < trees.length) {
    const arrow = indexWhere(trees, i, trees.length, (t) => isPunct(t, '=>'));
    if (arrow < 0) {
      for (const fact of scanTokens(trees.slice(i))) facts.push(fact);
      break;
    }
    const guardAt = indexWhere(trees, i, arrow, (t) => isWord(t, 'if'));
    const patternEnd = guardAt < 0 ? arrow : guardAt;
    facts.push({
      kind: 'match-arm',
      bindings: patternBindings(trees.slice(i, patternEnd)),
      span: spanOfRange(trees, i, arrow + 1),
    });
    if (guardAt >= 0) {
      for (const fact of scanTokens(trees.slice(guardAt + 1, arrow))) facts.push(fact);
    }

    i = arrow + 1;
    const body = groupOf(trees[i], '{');
    if (body !== undefined) {
      for (const fact of scanTokens(body.children)) facts.push(fact);
      i += 1;
      if (isPunct(trees[i], ',')) i += 1;
    } else {
      const comma = indexWhere(trees, i, trees.length, (t) => isPunct(t, ','));
      const end = comma < 0 ? trees.length : comma;
      for (const fact of scanTokens(trees.slice(i, end))) facts.push(fact);
      i = comma < 0 ? trees.length : comma + 1;
    }
  }
  return facts;
}

/** `match SCRUTINEE { ARMS }`. The scrutinee is scanned as an expression, the arms as arms. */
function scanMatch(trees: readonly TokenTree[], i: number, facts: BodyFact[]): number {
  const bodyAt = indexWhere(trees, i + 1, trees.length, (t) => groupOf(t, '{') !== undefined);
  if (bodyAt < 0) return i + 1;
  for (const fact of scanTokens(trees.slice(i + 1, bodyAt))) facts.push(fact);
  const body = groupOf(trees[bodyAt], '{');
  if (body !== undefined) {
    for (const fact of scanMatchArms(body.children)) facts.push(fact);
  }
  return bodyAt + 1;
}

// ── Closures ────────────────────────────────────────────────

/** Keywords that end an operand, so a `|` after them is binary or, not a closure. */
const OPERAND_KEYWORDS: ReadonlySet<string> = new Set([
  'self',
  'Self',
  'super',
  'crate',
  'true',
  'false',
]);

/** True when a `|` at `index` starts a closure: the token before it cannot end an operand. */
function startsClosure(trees: readonly TokenTree[], index: number): boolean {
  const previous = trees[index - 1];
  if (previous === undefined) return true;
  if (isTokenGroup(previous)) return false;
  switch (previous.kind) {
    case 'ident':
      return isKeyword(previous) && !OPERAND_KEYWORDS.has(previous.value);
    case 'punct':
      return previous.text !== '?';
    case 'int':
    case 'float':
    case 'char':
    case 'byte':
    case 'str':
    case 'byte_str':
    case 'c_str':
      return false;
    default:
      return true;
  }
}

/** `|PARAMS| BODY` or `|| BODY`. The body is scanned as ordinary tokens after the closing bar. */
function closureAt(trees: readonly TokenTree[], i: number, facts: BodyFact[]): number {
  if (isPunct(trees[i], '||')) {
    facts.push({ kind: 'closure', params: [], span: spanOfRange(trees, i, i + 1) });
    return i + 1;
  }
  const close = indexWhere(trees, i + 1, trees.length, (t) => isPunct(t, '|'));
  if (close < 0) return i + 1;
  const params: Binding[] = [];
  for (const segment of splitTopLevel(trees.slice(i + 1, close), ',')) {
    const colon = segment.findIndex((t) => isPunct(t, ':'));
    for (const binding of patternBindings(colon < 0 ? segment : segment.slice(0, colon))) {
      params.push(binding);
    }
  }
  facts.push({ kind: 'closure', params, span: spanOfRange(trees, i, close + 1) });
  return close + 1;
}

// ── Headers and struct literals ─────────────────────────────

/**
 * Scans the header of `if`, `while` or a `for` iterator: everything up to the first top-level
 * `{`, which opens the body. Rust forbids struct literals in these positions, so `if x == Y { z }`
 * reads as a comparison followed by a block. Returns the index of the body brace.
 */
function scanHeader(trees: readonly TokenTree[], from: number, facts: BodyFact[]): number {
  const end = indexWhere(trees, from, trees.length, (t) => groupOf(t, '{') !== undefined);
  const stop = end < 0 ? trees.length : end;
  for (const fact of scanTokens(trees.slice(from, stop))) facts.push(fact);
  return stop;
}

/** A field name: an identifier (not a keyword, except `self`) or a tuple index such as `0`. */
function fieldNameOf(tree: TokenTree): RustToken | undefined {
  if (isTokenGroup(tree)) return undefined;
  if (tree.kind === 'int') return tree;
  const token = identToken(tree);
  if (token === undefined || (isKeyword(token) && !PATH_KEYWORDS.has(token.value)))
    return undefined;
  return token;
}

/**
 * The fields of a struct literal body, with the tokens of each value. Returns undefined unless
 * every comma-separated part is `name`, `name: value` or `..base`, so a block such as `{ f(); }`
 * is never read as a literal.
 */
/** The field's tokens with any leading `#[...]` attributes removed. */
function withoutFieldAttributes(segment: TokenTree[]): TokenTree[] {
  let rest = segment;
  while (isPunct(rest[0], '#') && groupOf(rest[1], '[') !== undefined) rest = rest.slice(2);
  return rest;
}

function structFields(
  children: readonly TokenTree[],
): { fields: StructField[]; values: TokenTree[][] } | undefined {
  const segments = splitTopLevel(children, ',');
  if (segments.at(-1)?.length === 0) segments.pop();
  const fields: StructField[] = [];
  const values: TokenTree[][] = [];
  for (const rawSegment of segments) {
    // Outer attributes such as `#[cfg(...)]` only gate the field, so the field is what follows them.
    const segment = withoutFieldAttributes(rawSegment);
    const first = segment[0];
    if (first === undefined) return undefined;
    if (isPunct(first, '..')) {
      values.push(segment.slice(1));
      continue;
    }
    const token = fieldNameOf(first);
    if (token === undefined) return undefined;
    const name = String(token.kind === 'int' ? token.text : token.value);
    if (segment.length === 1) {
      fields.push({ name, shorthand: true, span: spanOfToken(token) });
      values.push(segment);
      continue;
    }
    if (!isPunct(segment[1], ':') || segment.length < 3) return undefined;
    fields.push({ name, shorthand: false, span: spanOfToken(token) });
    values.push(segment.slice(2));
  }
  return { fields, values };
}

// ── The scan ────────────────────────────────────────────────

/** The macro arguments after `path!`, or undefined when the path is not a macro call. */
function macroCallAt(
  trees: readonly TokenTree[],
  path: { segments: string[]; end: number },
): TokenGroup | undefined {
  return isPunct(trees[path.end], '!') ? anyGroupAt(trees, path.end + 1) : undefined;
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
    if ((isPunct(tree, '|') || isPunct(tree, '||')) && startsClosure(trees, i)) {
      i = closureAt(trees, i, facts);
      continue;
    }

    const token = identToken(tree);
    if (token !== undefined && isKeyword(token)) {
      if (ITEM_KEYWORDS.has(token.value)) {
        const end = skipItem(trees, i);
        facts.push({ kind: 'item', keyword: token.value, span: spanOfRange(trees, i, end) });
        i = end;
        continue;
      }
      if (token.value === 'let') {
        i = scanLet(trees, i, facts);
        continue;
      }
      if (token.value === 'if' || token.value === 'while') {
        i = scanHeader(trees, i + 1, facts);
        continue;
      }
      if (token.value === 'for') {
        i = scanFor(trees, i, facts);
        continue;
      }
      if (token.value === 'match') {
        i = scanMatch(trees, i, facts);
        continue;
      }
    }

    const path = readPath(trees, i);
    if (path === undefined) {
      i += 1;
      continue;
    }
    const span = spanOfRange(trees, i, path.end);
    const macroArgs = macroCallAt(trees, path);
    if (macroArgs !== undefined) {
      facts.push({
        kind: 'macro-call',
        path: path.segments,
        args: macroArgs,
        span: spanOfRange(trees, i, path.end + 2),
      });
      const name = path.segments[path.segments.length - 1] ?? '';
      for (const fact of scanTokens(expressionArgsOf(name, macroArgs))) facts.push(fact);
      i = path.end + 2;
      continue;
    }
    const body = groupOf(trees[path.end], '{');
    const literal = body === undefined ? undefined : structFields(body.children);
    if (body !== undefined && literal !== undefined) {
      facts.push({
        kind: 'struct-literal',
        path: path.segments,
        fields: literal.fields,
        span: spanBetween(tree, body),
      });
      for (const value of literal.values) {
        for (const fact of scanTokens(value)) facts.push(fact);
      }
      i = path.end + 1;
      continue;
    }
    const args = groupOf(trees[path.end], '(');
    if (args !== undefined) {
      facts.push({ kind: 'call', path: path.segments, args, span: spanBetween(tree, args) });
      i = path.end;
      continue;
    }
    facts.push({ kind: 'path', segments: path.segments, span });
    i = path.end;
  }
  return facts;
}

/** Facts for one function body, as found in `FnItem.body`. */
export function scanFunctionBody(body: TokenGroup): BodyFact[] {
  return scanTokens(body.children);
}
