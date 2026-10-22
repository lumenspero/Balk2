/**
 * Rust item parser (V3 Phase 6.3, part a: attributes, visibility, `use` and `mod`).
 *
 * Items are parsed from token trees, so brackets and braces are already matched. Item
 * forms that are not yet parsed are kept as `unknown` with no error, so a valid file
 * never reports a false syntax problem. Later parts add the remaining forms.
 *
 * Positions are 1-based, as in the lexer.
 */

import { isKeyword, lexRust, type RustLexNote } from './lexer.js';
import {
  buildTokenTrees,
  isTokenGroup,
  type Delimiter,
  type TokenGroup,
  type TokenTree,
} from './token-tree.js';

export interface Span {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface Attribute {
  /** True for `#![...]`, false for `#[...]`. */
  readonly inner: boolean;
  /** The attribute path, such as `derive`, `cfg` or `rustfmt::skip`. */
  readonly path: string;
  /** The tokens after the path, as token trees (for example the `(...)` of `derive(...)`). */
  readonly args: readonly TokenTree[];
  /** The arguments rendered with a single space between tokens. Spacing is normalized. */
  readonly raw: string;
  readonly span: Span;
}

export type Visibility =
  | { readonly kind: 'private' }
  | { readonly kind: 'public' }
  | {
      readonly kind: 'restricted';
      readonly scope: 'crate' | 'super' | 'self' | 'in';
      readonly path: readonly string[];
    };

export type UseTree =
  | { readonly kind: 'name'; readonly path: readonly string[]; readonly alias: string | null }
  | { readonly kind: 'glob'; readonly path: readonly string[] }
  | {
      readonly kind: 'nested';
      readonly path: readonly string[];
      readonly items: readonly UseTree[];
    };

interface ItemBase {
  readonly attrs: readonly Attribute[];
  readonly vis: Visibility;
  readonly span: Span;
}

export type ItemBody =
  | {
      readonly kind: 'mod';
      readonly name: string;
      /** False for `mod name;`, whose body is in another file. */
      readonly inline: boolean;
      readonly innerAttrs: readonly Attribute[];
      readonly items: readonly Item[];
    }
  | { readonly kind: 'use'; readonly tree: UseTree | null }
  | {
      readonly kind: 'trait';
      readonly name: string;
      readonly generics: readonly GenericParam[];
      readonly unsafe: boolean;
      readonly auto: boolean;
      /** The supertrait bounds after `:`, or null. */
      readonly supertraits: Fragment | null;
      readonly where: string;
      readonly innerAttrs: readonly Attribute[];
      readonly items: readonly Item[];
    }
  | {
      readonly kind: 'impl';
      readonly generics: readonly GenericParam[];
      readonly unsafe: boolean;
      readonly negative: boolean;
      /** The trait path for `impl Trait for Type`, or null for an inherent impl. */
      readonly trait: Fragment | null;
      readonly selfTy: Fragment;
      readonly where: string;
      readonly innerAttrs: readonly Attribute[];
      readonly items: readonly Item[];
    }
  | {
      readonly kind: 'macro_rules';
      readonly name: string;
      /** The rules as a token group. Their syntax is parsed in Phase 10. */
      readonly body: TokenGroup;
    }
  | {
      readonly kind: 'macro_call';
      readonly path: string;
      readonly delimiter: Delimiter;
      readonly args: TokenGroup;
    }
  | { readonly kind: 'extern_crate'; readonly name: string; readonly alias: string | null }
  | {
      readonly kind: 'extern_block';
      readonly abi: string | null;
      readonly innerAttrs: readonly Attribute[];
      readonly items: readonly Item[];
    }
  | DeclBody
  | { readonly kind: 'unknown'; readonly keyword: string | null };

export type Item = ItemBody & ItemBase;

export interface RustFile {
  readonly innerAttrs: readonly Attribute[];
  readonly items: readonly Item[];
  /** Problems from every stage (lexer, token trees, items), in source order. */
  readonly errors: readonly RustLexNote[];
}

/** A cursor over a list of token trees. Groups get their own cursor. */
export class TreeCursor {
  pos = 0;

  constructor(readonly trees: readonly TokenTree[]) {}

  get eof(): boolean {
    return this.pos >= this.trees.length;
  }

  peek(offset = 0): TokenTree | undefined {
    return this.trees[this.pos + offset];
  }

  next(): TokenTree | undefined {
    const tree = this.trees[this.pos];
    if (tree !== undefined) this.pos += 1;
    return tree;
  }
}

function isPunct(tree: TokenTree | undefined, text: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'punct' && tree.text === text;
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

function groupOf(tree: TokenTree | undefined, delimiter: Delimiter): TokenGroup | undefined {
  return tree !== undefined && isTokenGroup(tree) && tree.delimiter === delimiter
    ? tree
    : undefined;
}

/** The name of any identifier, keywords included (path segments such as `crate` or `self`). */
function identName(tree: TokenTree | undefined): string | undefined {
  if (tree === undefined || isTokenGroup(tree) || tree.kind !== 'ident') return undefined;
  return tree.value;
}

/** The name of a declared item. Keywords are rejected. */
function nameOf(tree: TokenTree | undefined): string | undefined {
  if (tree === undefined || isTokenGroup(tree) || tree.kind !== 'ident') return undefined;
  return isKeyword(tree) ? undefined : tree.value;
}

function keywordOf(tree: TokenTree | undefined): string | null {
  if (tree === undefined || isTokenGroup(tree) || tree.kind !== 'ident' || tree.raw) return null;
  return tree.value;
}

function spanBetween(first: TokenTree, last: TokenTree): Span {
  return {
    line: first.line,
    column: first.column,
    endLine: last.endLine,
    endColumn: last.endColumn,
  };
}

function spanOfRange(trees: readonly TokenTree[], from: number, to: number): Span {
  const first = trees[from];
  const last = trees[to - 1];
  if (!first || !last) return { line: 1, column: 1, endLine: 1, endColumn: 1 };
  return spanBetween(first, last);
}

/** Where the next token is, or where the input ends. Used for error positions. */
function locate(c: TreeCursor): { line: number; column: number } {
  const here = c.peek();
  if (here) return { line: here.line, column: here.column };
  const last = c.trees.at(-1);
  if (last) return { line: last.endLine, column: last.endColumn };
  return { line: 1, column: 1 };
}

function fail(errors: RustLexNote[], c: TreeCursor, message: string): void {
  const at = locate(c);
  errors.push({ message, line: at.line, column: at.column });
}

function renderTree(tree: TokenTree): string {
  if (!isTokenGroup(tree)) return tree.text;
  const inner = tree.children.map(renderTree).join(' ');
  return `${tree.open.text}${inner}${tree.close?.text ?? ''}`;
}

/** Path segments in a token list, skipping `::`. */
function pathOf(trees: readonly TokenTree[]): string[] {
  const segments: string[] = [];
  for (const tree of trees) {
    const name = identName(tree);
    if (name !== undefined) segments.push(name);
  }
  return segments;
}

// ── Attributes ──────────────────────────────────────────────

function parseAttribute(c: TreeCursor, errors: RustLexNote[]): Attribute | undefined {
  const hash = c.next();
  if (!hash) return undefined;
  const inner = isPunct(c.peek(), '!');
  if (inner) c.next();
  const group = groupOf(c.peek(), '[');
  if (!group) {
    fail(errors, c, 'expected `[` after `#`');
    return undefined;
  }
  c.next();

  const body = new TreeCursor(group.children);
  const segments: string[] = [];
  for (;;) {
    const name = identName(body.peek());
    if (name === undefined) break;
    segments.push(name);
    body.next();
    if (!isPunct(body.peek(), '::')) break;
    body.next();
  }
  const args = body.trees.slice(body.pos);
  return {
    inner,
    path: segments.join('::'),
    args,
    raw: args.map(renderTree).join(' '),
    span: spanBetween(hash, group),
  };
}

function parseOuterAttributes(c: TreeCursor, errors: RustLexNote[]): Attribute[] {
  const attrs: Attribute[] = [];
  while (isPunct(c.peek(), '#') && !isPunct(c.peek(1), '!')) {
    const attr = parseAttribute(c, errors);
    if (attr) attrs.push(attr);
  }
  return attrs;
}

// ── Visibility ──────────────────────────────────────────────

function scopeOf(tree: TokenTree | undefined): 'crate' | 'super' | 'self' | undefined {
  if (isWord(tree, 'crate')) return 'crate';
  if (isWord(tree, 'super')) return 'super';
  if (isWord(tree, 'self')) return 'self';
  return undefined;
}

function parseVisibility(c: TreeCursor): Visibility {
  if (!isWord(c.peek(), 'pub')) return { kind: 'private' };
  c.next();
  const restriction = groupOf(c.peek(), '(');
  if (!restriction) return { kind: 'public' };

  const [first, ...rest] = restriction.children;
  const scope = scopeOf(first);
  if (scope && rest.length === 0) {
    c.next();
    return { kind: 'restricted', scope, path: [] };
  }
  if (isWord(first, 'in')) {
    c.next();
    return { kind: 'restricted', scope: 'in', path: pathOf(rest) };
  }
  // Not a restriction, so the parenthesized group is left for the item.
  return { kind: 'public' };
}

// ── use ─────────────────────────────────────────────────────

function parseUseTree(
  c: TreeCursor,
  prefix: readonly string[],
  errors: RustLexNote[],
): UseTree | null {
  if (isPunct(c.peek(), '::')) c.next();
  const path = [...prefix];
  for (;;) {
    const here = c.peek();
    const list = groupOf(here, '{');
    if (list) {
      c.next();
      return {
        kind: 'nested',
        path,
        items: parseUseList(new TreeCursor(list.children), path, errors),
      };
    }
    if (isPunct(here, '*')) {
      c.next();
      return { kind: 'glob', path };
    }
    const segment = identName(here);
    if (segment === undefined) {
      fail(errors, c, 'expected a path segment in use declaration');
      return null;
    }
    c.next();
    path.push(segment);
    if (!isPunct(c.peek(), '::')) break;
    c.next();
  }

  let alias: string | null = null;
  if (isWord(c.peek(), 'as')) {
    c.next();
    const name = nameOf(c.peek());
    if (name === undefined) {
      fail(errors, c, 'expected a name after `as`');
    } else {
      c.next();
      alias = name;
    }
  }
  return { kind: 'name', path, alias };
}

function parseUseList(c: TreeCursor, prefix: readonly string[], errors: RustLexNote[]): UseTree[] {
  const items: UseTree[] = [];
  while (!c.eof) {
    const before = c.pos;
    const tree = parseUseTree(c, prefix, errors);
    if (tree) items.push(tree);
    if (tree === null && c.pos === before) c.next();
    if (isPunct(c.peek(), ',')) {
      c.next();
    } else if (tree !== null && !c.eof) {
      fail(errors, c, 'expected `,` in use list');
    }
  }
  return items;
}

function parseUse(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  c.next();
  const tree = parseUseTree(c, [], errors);
  if (isPunct(c.peek(), ';')) c.next();
  else fail(errors, c, 'expected `;` after use declaration');
  return { kind: 'use', tree };
}

// ── mod ─────────────────────────────────────────────────────

function skipUnknownItem(c: TreeCursor): void {
  while (!c.eof) {
    const tree = c.next();
    if (isPunct(tree, ';') || groupOf(tree, '{')) return;
  }
}

function parseMod(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  c.next();
  const name = nameOf(c.peek());
  if (name === undefined) {
    fail(errors, c, 'expected a module name');
    skipUnknownItem(c);
    return { kind: 'unknown', keyword: 'mod' };
  }
  c.next();

  if (isPunct(c.peek(), ';')) {
    c.next();
    return { kind: 'mod', name, inline: false, innerAttrs: [], items: [] };
  }
  const body = groupOf(c.peek(), '{');
  if (body) {
    c.next();
    const parsed = parseItems(new TreeCursor(body.children), errors);
    return { kind: 'mod', name, inline: true, innerAttrs: parsed.innerAttrs, items: parsed.items };
  }
  fail(errors, c, 'expected `;` or `{` after module name');
  return { kind: 'mod', name, inline: false, innerAttrs: [], items: [] };
}

// ── Items ───────────────────────────────────────────────────

function parseUnknown(c: TreeCursor, keyword: string | null): ItemBody {
  skipUnknownItem(c);
  return { kind: 'unknown', keyword };
}

function parseItem(c: TreeCursor, errors: RustLexNote[]): Item {
  const start = c.pos;
  const attrs = parseOuterAttributes(c, errors);
  const vis = parseVisibility(c);
  const keyword = keywordOf(c.peek());
  const body: ItemBody = parseBody(c, errors, keyword);
  return { ...body, attrs, vis, span: spanOfRange(c.trees, start, c.pos) };
}

/** Items and inner attributes from one list of token trees (a file or a module body). */
export function parseItems(
  c: TreeCursor,
  errors: RustLexNote[],
): { innerAttrs: Attribute[]; items: Item[] } {
  const innerAttrs: Attribute[] = [];
  const items: Item[] = [];
  while (!c.eof) {
    if (isPunct(c.peek(), '#') && isPunct(c.peek(1), '!')) {
      const attr = parseAttribute(c, errors);
      if (attr) innerAttrs.push(attr);
      continue;
    }
    if (isPunct(c.peek(), ';')) {
      fail(errors, c, 'expected item, found `;`');
      c.next();
      continue;
    }
    items.push(parseItem(c, errors));
  }
  return { innerAttrs, items };
}

/** Lexes, builds token trees and parses items for one Rust source file. */
export function parseRustFile(source: string): RustFile {
  const lexed = lexRust(source);
  const trees = buildTokenTrees(lexed.tokens);
  const itemErrors: RustLexNote[] = [];
  const parsed = parseItems(new TreeCursor(trees.trees), itemErrors);
  const errors = [...lexed.errors, ...trees.errors, ...itemErrors].sort(
    (a, b) => a.line - b.line || a.column - b.column,
  );
  return { innerAttrs: parsed.innerAttrs, items: parsed.items, errors };
}

// ── Declarations (V3 Phase 6.3b) ────────────────────────────

/** Tokens kept both as written and as token trees, so later phases can resolve them. */
export interface Fragment {
  readonly raw: string;
  readonly tokens: readonly TokenTree[];
}

export interface GenericParam {
  readonly kind: 'lifetime' | 'type' | 'const';
  readonly name: string;
  /** The whole parameter as written, including bounds and defaults. */
  readonly raw: string;
}

export interface Qualifiers {
  readonly const: boolean;
  readonly async: boolean;
  readonly unsafe: boolean;
  /** True when `extern` is present, with or without an ABI string. */
  readonly extern: boolean;
  /** The ABI string as written (for example `"C"`), or null. */
  readonly abi: string | null;
}

export type FnParam =
  | { readonly kind: 'self'; readonly raw: string; readonly type: Fragment | null }
  | { readonly kind: 'typed'; readonly pattern: string; readonly type: Fragment };

export interface Field {
  readonly attrs: readonly Attribute[];
  readonly vis: Visibility;
  /** Null for a tuple field. */
  readonly name: string | null;
  readonly type: Fragment;
}

export interface Variant {
  readonly name: string;
  readonly attrs: readonly Attribute[];
  readonly shape: 'unit' | 'tuple' | 'struct';
  readonly fields: readonly Field[];
  readonly discriminant: Fragment | null;
}

export type DeclBody =
  | {
      readonly kind: 'fn';
      readonly name: string;
      readonly qualifiers: Qualifiers;
      readonly generics: readonly GenericParam[];
      readonly params: readonly FnParam[];
      readonly ret: Fragment | null;
      readonly where: string;
      /** Null for a declaration without a body, such as a trait method. */
      readonly body: TokenGroup | null;
    }
  | {
      readonly kind: 'struct';
      readonly name: string;
      readonly generics: readonly GenericParam[];
      readonly where: string;
      readonly shape: 'unit' | 'tuple' | 'named';
      readonly fields: readonly Field[];
    }
  | {
      readonly kind: 'union';
      readonly name: string;
      readonly generics: readonly GenericParam[];
      readonly where: string;
      readonly fields: readonly Field[];
    }
  | {
      readonly kind: 'enum';
      readonly name: string;
      readonly generics: readonly GenericParam[];
      readonly where: string;
      readonly variants: readonly Variant[];
    }
  | {
      readonly kind: 'type';
      readonly name: string;
      readonly generics: readonly GenericParam[];
      readonly bounds: Fragment | null;
      readonly ty: Fragment | null;
    }
  | {
      readonly kind: 'const';
      readonly name: string;
      readonly ty: Fragment | null;
      readonly value: Fragment | null;
    }
  | {
      readonly kind: 'static';
      readonly name: string;
      readonly mutable: boolean;
      readonly ty: Fragment | null;
      readonly value: Fragment | null;
    };

/** Change in angle-bracket depth for one token. `>>` closes two levels, `<<` opens two. */
const ANGLE_DELTA: Readonly<Record<string, number>> = { '<': 1, '<<': 2, '>': -1, '>>': -2 };

function angleDelta(tree: TokenTree): number {
  if (isTokenGroup(tree) || tree.kind !== 'punct') return 0;
  return ANGLE_DELTA[tree.text] ?? 0;
}

function renderTokens(trees: readonly TokenTree[]): string {
  return trees.map(renderTree).join(' ');
}

function fragmentOf(trees: readonly TokenTree[]): Fragment {
  return { raw: renderTokens(trees), tokens: trees };
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

/**
 * Reads tokens up to the `>` that closes an opened `<`, and consumes that `>`.
 * Returns null at end of input. A `>>` that closes past the list consumes its second `>`
 * too; that only happens on malformed input.
 */
function takeAngleGroup(c: TreeCursor): TokenTree[] | null {
  const out: TokenTree[] = [];
  let depth = 1;
  for (;;) {
    const tree = c.next();
    if (tree === undefined) return null;
    depth += angleDelta(tree);
    if (depth <= 0) return out;
    out.push(tree);
  }
}

/** Reads tokens until `stop` matches (the matching token is not consumed). */
function takeUntil(c: TreeCursor, stop: (tree: TokenTree) => boolean): TokenTree[] {
  const out: TokenTree[] = [];
  while (!c.eof) {
    const tree = c.peek();
    if (tree === undefined || stop(tree)) break;
    c.next();
    out.push(tree);
  }
  return out;
}

function parseWhere(c: TreeCursor): string {
  if (!isWord(c.peek(), 'where')) return '';
  c.next();
  return renderTokens(takeUntil(c, (t) => groupOf(t, '{') !== undefined || isPunct(t, ';')));
}

function parseGenerics(c: TreeCursor, errors: RustLexNote[]): GenericParam[] {
  if (!isPunct(c.peek(), '<')) return [];
  c.next();
  const inside = takeAngleGroup(c);
  if (!inside) {
    fail(errors, c, 'unclosed generic parameter list');
    return [];
  }
  const params: GenericParam[] = [];
  for (const segment of splitTopLevel(inside, ',')) {
    const param = genericParamOf(segment);
    if (param) params.push(param);
  }
  return params;
}

function genericParamOf(segment: readonly TokenTree[]): GenericParam | null {
  const [first, second] = segment;
  if (first === undefined) return null;
  const raw = renderTokens(segment);
  if (!isTokenGroup(first) && first.kind === 'lifetime') {
    return { kind: 'lifetime', name: first.text, raw };
  }
  if (isWord(first, 'const')) {
    const name = identName(second);
    return name === undefined ? null : { kind: 'const', name, raw };
  }
  const name = identName(first);
  return name === undefined ? null : { kind: 'type', name, raw };
}

/** Name, then generics. Consumes the keyword. Returns null (after skipping the item) if no name. */
function parseHeader(
  c: TreeCursor,
  errors: RustLexNote[],
  keyword: string,
): { name: string; generics: GenericParam[] } | null {
  c.next();
  const name = nameOf(c.peek());
  if (name === undefined) {
    fail(errors, c, `expected a ${keyword} name`);
    skipUnknownItem(c);
    return null;
  }
  c.next();
  return { name, generics: parseGenerics(c, errors) };
}

// ── Functions ───────────────────────────────────────────────

const SELF_PARAM = /^(&\s*('[A-Za-z_]\w*\s*)?)?(mut\s+)?self$/;

function paramOf(segment: readonly TokenTree[]): FnParam | null {
  if (segment.length === 0) return null;
  const colon = segment.findIndex((t) => isPunct(t, ':'));
  if (colon < 0) {
    const raw = renderTokens(segment);
    return SELF_PARAM.test(raw)
      ? { kind: 'self', raw, type: null }
      : { kind: 'typed', pattern: '', type: fragmentOf(segment) };
  }
  const pattern = renderTokens(segment.slice(0, colon));
  const typeTokens = segment.slice(colon + 1);
  if (SELF_PARAM.test(pattern)) {
    return {
      kind: 'self',
      raw: renderTokens(segment),
      type: typeTokens.length > 0 ? fragmentOf(typeTokens) : null,
    };
  }
  return { kind: 'typed', pattern, type: fragmentOf(typeTokens) };
}

function parseQualifiers(c: TreeCursor): Qualifiers {
  const found = { const: false, async: false, unsafe: false, extern: false };
  let abi: string | null = null;
  for (;;) {
    const tree = c.peek();
    if (isWord(tree, 'const')) found.const = true;
    else if (isWord(tree, 'async')) found.async = true;
    else if (isWord(tree, 'unsafe')) found.unsafe = true;
    else if (isWord(tree, 'extern')) {
      found.extern = true;
      c.next();
      const literal = c.peek();
      if (literal !== undefined && !isTokenGroup(literal) && literal.kind === 'str') {
        abi = literal.text;
        c.next();
      }
      continue;
    } else break;
    c.next();
  }
  return { ...found, abi };
}

/** True when the item starts a function: qualifiers, then `fn`. */
function isFnStart(c: TreeCursor): boolean {
  for (let offset = 0; ; offset += 1) {
    const tree = c.peek(offset);
    if (isWord(tree, 'fn')) return true;
    if (isWord(tree, 'const') || isWord(tree, 'async') || isWord(tree, 'unsafe')) continue;
    if (isWord(tree, 'extern')) continue;
    const afterExtern =
      offset > 0 &&
      isWord(c.peek(offset - 1), 'extern') &&
      tree !== undefined &&
      !isTokenGroup(tree);
    if (afterExtern && tree.kind === 'str') continue;
    return false;
  }
}

function parseFn(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  const qualifiers = parseQualifiers(c);
  const header = parseHeader(c, errors, 'fn');
  if (!header) return { kind: 'unknown', keyword: 'fn' };

  const paramGroup = groupOf(c.peek(), '(');
  if (!paramGroup) {
    fail(errors, c, 'expected `(` after function name');
    skipUnknownItem(c);
    return { kind: 'unknown', keyword: 'fn' };
  }
  c.next();
  const params = splitTopLevel(paramGroup.children, ',')
    .map(paramOf)
    .filter((p): p is FnParam => p !== null);

  let ret: Fragment | null = null;
  if (isPunct(c.peek(), '->')) {
    c.next();
    ret = fragmentOf(
      takeUntil(c, (t) => isWord(t, 'where') || groupOf(t, '{') !== undefined || isPunct(t, ';')),
    );
  }
  const where = parseWhere(c);

  const body = groupOf(c.peek(), '{');
  if (body) c.next();
  else if (isPunct(c.peek(), ';')) c.next();
  else fail(errors, c, 'expected `{` or `;` after function signature');

  return {
    kind: 'fn',
    name: header.name,
    qualifiers,
    generics: header.generics,
    params,
    ret,
    where,
    body: body ?? null,
  };
}

// ── Structs, enums and unions ───────────────────────────────

function parseFields(trees: readonly TokenTree[], named: boolean, errors: RustLexNote[]): Field[] {
  const fields: Field[] = [];
  for (const segment of splitTopLevel(trees, ',')) {
    if (segment.length === 0) continue;
    const sub = new TreeCursor(segment);
    const attrs = parseOuterAttributes(sub, errors);
    const vis = parseVisibility(sub);
    let name: string | null = null;
    if (named) {
      const fieldName = nameOf(sub.peek());
      if (fieldName === undefined) {
        fail(errors, sub, 'expected a field name');
        continue;
      }
      sub.next();
      if (!isPunct(sub.peek(), ':')) {
        fail(errors, sub, 'expected `:` after field name');
        continue;
      }
      sub.next();
      name = fieldName;
    }
    fields.push({ attrs, vis, name, type: fragmentOf(sub.trees.slice(sub.pos)) });
  }
  return fields;
}

function parseStruct(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  const header = parseHeader(c, errors, 'struct');
  if (!header) return { kind: 'unknown', keyword: 'struct' };

  let where = parseWhere(c);
  const named = groupOf(c.peek(), '{');
  if (named) {
    c.next();
    return {
      kind: 'struct',
      name: header.name,
      generics: header.generics,
      where,
      shape: 'named',
      fields: parseFields(named.children, true, errors),
    };
  }
  const tuple = groupOf(c.peek(), '(');
  if (tuple) {
    c.next();
    const after = parseWhere(c);
    where = [where, after].filter((part) => part !== '').join(' ');
    if (isPunct(c.peek(), ';')) c.next();
    else fail(errors, c, 'expected `;` after tuple struct');
    return {
      kind: 'struct',
      name: header.name,
      generics: header.generics,
      where,
      shape: 'tuple',
      fields: parseFields(tuple.children, false, errors),
    };
  }
  if (isPunct(c.peek(), ';')) {
    c.next();
    return {
      kind: 'struct',
      name: header.name,
      generics: header.generics,
      where,
      shape: 'unit',
      fields: [],
    };
  }
  fail(errors, c, 'expected `{`, `(` or `;` after struct name');
  skipUnknownItem(c);
  return { kind: 'unknown', keyword: 'struct' };
}

function variantOf(segment: readonly TokenTree[], errors: RustLexNote[]): Variant | null {
  if (segment.length === 0) return null;
  const sub = new TreeCursor(segment);
  const attrs = parseOuterAttributes(sub, errors);
  const name = nameOf(sub.peek());
  if (name === undefined) {
    fail(errors, sub, 'expected a variant name');
    return null;
  }
  sub.next();

  let shape: Variant['shape'] = 'unit';
  let fields: Field[] = [];
  const tuple = groupOf(sub.peek(), '(');
  const named = groupOf(sub.peek(), '{');
  if (tuple) {
    sub.next();
    shape = 'tuple';
    fields = parseFields(tuple.children, false, errors);
  } else if (named) {
    sub.next();
    shape = 'struct';
    fields = parseFields(named.children, true, errors);
  }

  let discriminant: Fragment | null = null;
  if (isPunct(sub.peek(), '=')) {
    sub.next();
    discriminant = fragmentOf(sub.trees.slice(sub.pos));
    sub.pos = sub.trees.length;
  } else if (!sub.eof) {
    fail(errors, sub, 'unexpected token in enum variant');
  }
  return { name, attrs, shape, fields, discriminant };
}

function parseEnum(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  const header = parseHeader(c, errors, 'enum');
  if (!header) return { kind: 'unknown', keyword: 'enum' };
  const where = parseWhere(c);
  const body = groupOf(c.peek(), '{');
  if (!body) {
    fail(errors, c, 'expected `{` after enum name');
    skipUnknownItem(c);
    return { kind: 'unknown', keyword: 'enum' };
  }
  c.next();
  const variants: Variant[] = [];
  for (const segment of splitTopLevel(body.children, ',')) {
    const variant = variantOf(segment, errors);
    if (variant) variants.push(variant);
  }
  return { kind: 'enum', name: header.name, generics: header.generics, where, variants };
}

/** `union` is a weak keyword: it starts a union only as `union Name<..>` or `union Name {`. */
function isUnionStart(c: TreeCursor): boolean {
  if (identName(c.peek(1)) === undefined) return false;
  return isPunct(c.peek(2), '<') || groupOf(c.peek(2), '{') !== undefined;
}

function parseUnion(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  const header = parseHeader(c, errors, 'union');
  if (!header) return { kind: 'unknown', keyword: 'union' };
  const where = parseWhere(c);
  const body = groupOf(c.peek(), '{');
  if (!body) {
    fail(errors, c, 'expected `{` after union name');
    skipUnknownItem(c);
    return { kind: 'unknown', keyword: 'union' };
  }
  c.next();
  return {
    kind: 'union',
    name: header.name,
    generics: header.generics,
    where,
    fields: parseFields(body.children, true, errors),
  };
}

// ── Type aliases, constants and statics ─────────────────────

/** `= value ;`, or just `;`. Returns the value, or null when there is none. */
function parseValueTail(c: TreeCursor, errors: RustLexNote[]): Fragment | null {
  let value: Fragment | null = null;
  if (isPunct(c.peek(), '=')) {
    c.next();
    value = fragmentOf(takeUntil(c, (t) => isPunct(t, ';')));
  }
  if (isPunct(c.peek(), ';')) c.next();
  else fail(errors, c, 'expected `;` after item');
  return value;
}

function parseTypeAlias(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  const header = parseHeader(c, errors, 'type');
  if (!header) return { kind: 'unknown', keyword: 'type' };
  let bounds: Fragment | null = null;
  if (isPunct(c.peek(), ':')) {
    c.next();
    bounds = fragmentOf(takeUntil(c, (t) => isPunct(t, '=') || isPunct(t, ';')));
  }
  let ty: Fragment | null = null;
  if (isPunct(c.peek(), '=')) {
    c.next();
    ty = fragmentOf(takeUntil(c, (t) => isPunct(t, ';')));
  }
  if (isPunct(c.peek(), ';')) c.next();
  else fail(errors, c, 'expected `;` after type alias');
  return { kind: 'type', name: header.name, generics: header.generics, bounds, ty };
}

function parseConst(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  c.next();
  const name = nameOf(c.peek());
  if (name === undefined) {
    fail(errors, c, 'expected a constant name');
    skipUnknownItem(c);
    return { kind: 'unknown', keyword: 'const' };
  }
  c.next();
  let ty: Fragment | null = null;
  if (isPunct(c.peek(), ':')) {
    c.next();
    ty = fragmentOf(takeUntil(c, (t) => isPunct(t, '=') || isPunct(t, ';')));
  } else {
    fail(errors, c, 'expected `:` after constant name');
  }
  const value = parseValueTail(c, errors);
  return { kind: 'const', name, ty, value };
}

function parseStatic(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  c.next();
  const mutable = isWord(c.peek(), 'mut');
  if (mutable) c.next();
  const name = nameOf(c.peek());
  if (name === undefined) {
    fail(errors, c, 'expected a static name');
    skipUnknownItem(c);
    return { kind: 'unknown', keyword: 'static' };
  }
  c.next();
  let ty: Fragment | null = null;
  if (isPunct(c.peek(), ':')) {
    c.next();
    ty = fragmentOf(takeUntil(c, (t) => isPunct(t, '=') || isPunct(t, ';')));
  } else {
    fail(errors, c, 'expected `:` after static name');
  }
  const value = parseValueTail(c, errors);
  return { kind: 'static', name, mutable, ty, value };
}

// ── Dispatch ────────────────────────────────────────────────

function parseBody(c: TreeCursor, errors: RustLexNote[], keyword: string | null): ItemBody {
  if (isFnStart(c)) return parseFn(c, errors);
  if (keyword === 'macro_rules' && isPunct(c.peek(1), '!')) return parseMacroRules(c, errors);
  if (isMacroCallStart(c)) return parseMacroCall(c, errors);
  if (keyword === 'unsafe' && isWord(c.peek(1), 'extern')) {
    c.next();
    return parseExternBlock(c, errors);
  }
  switch (keyword) {
    case 'use':
      return parseUse(c, errors);
    case 'mod':
      return parseMod(c, errors);
    case 'struct':
      return parseStruct(c, errors);
    case 'enum':
      return parseEnum(c, errors);
    case 'union':
      return isUnionStart(c) ? parseUnion(c, errors) : parseUnknown(c, keyword);
    case 'type':
      return parseTypeAlias(c, errors);
    case 'const':
      return parseConst(c, errors);
    case 'static':
      return parseStatic(c, errors);
    case 'extern':
      return isWord(c.peek(1), 'crate') ? parseExternCrate(c, errors) : parseExternBlock(c, errors);
    case 'trait':
      return parseTrait(c, errors, { unsafe: false, auto: false });
    case 'impl':
      return parseImpl(c, errors, false);
    case 'unsafe':
    case 'auto':
      return isQualifiedTraitOrImpl(c)
        ? parseQualifiedTraitOrImpl(c, errors, keyword)
        : parseUnknown(c, keyword);
    default:
      return parseUnknown(c, keyword);
  }
}

// ── Traits and impls (V3 Phase 6.3c) ────────────────────────

/** The `{ … }` body of a trait or impl, parsed as items. Null (with a note) if missing. */
function parseBlock(
  c: TreeCursor,
  errors: RustLexNote[],
): { innerAttrs: Attribute[]; items: Item[] } | null {
  const body = groupOf(c.peek(), '{');
  if (!body) {
    fail(errors, c, 'expected `{` to open the body');
    if (isPunct(c.peek(), ';')) c.next();
    return null;
  }
  c.next();
  return parseItems(new TreeCursor(body.children), errors);
}

function parseTrait(
  c: TreeCursor,
  errors: RustLexNote[],
  flags: { unsafe: boolean; auto: boolean },
): ItemBody {
  const header = parseHeader(c, errors, 'trait');
  if (!header) return { kind: 'unknown', keyword: 'trait' };

  let supertraits: Fragment | null = null;
  if (isPunct(c.peek(), ':')) {
    c.next();
    supertraits = fragmentOf(
      takeUntil(c, (t) => isWord(t, 'where') || groupOf(t, '{') !== undefined),
    );
  }
  const where = parseWhere(c);
  const block = parseBlock(c, errors);
  if (!block) return { kind: 'unknown', keyword: 'trait' };
  return {
    kind: 'trait',
    name: header.name,
    generics: header.generics,
    unsafe: flags.unsafe,
    auto: flags.auto,
    supertraits,
    where,
    innerAttrs: block.innerAttrs,
    items: block.items,
  };
}

/** Index of the `for` that separates an impl's trait from its self type, outside angle brackets. */
function indexOfTopLevelFor(trees: readonly TokenTree[]): number {
  let depth = 0;
  for (const [index, tree] of trees.entries()) {
    if (depth === 0 && isWord(tree, 'for')) return index;
    depth = Math.max(0, depth + angleDelta(tree));
  }
  return -1;
}

function parseImpl(c: TreeCursor, errors: RustLexNote[], unsafe: boolean): ItemBody {
  c.next();
  const generics = parseGenerics(c, errors);
  const header = takeUntil(
    c,
    (t) => isWord(t, 'where') || groupOf(t, '{') !== undefined || isPunct(t, ';'),
  );

  let traitTokens: TokenTree[] | null = null;
  let selfTokens: TokenTree[] = header;
  const forAt = indexOfTopLevelFor(header);
  if (forAt >= 0) {
    traitTokens = header.slice(0, forAt);
    selfTokens = header.slice(forAt + 1);
  }
  let negative = false;
  if (traitTokens !== null && isPunct(traitTokens[0], '!')) {
    negative = true;
    traitTokens = traitTokens.slice(1);
  }

  const where = parseWhere(c);
  const block = parseBlock(c, errors);
  if (!block) return { kind: 'unknown', keyword: 'impl' };
  return {
    kind: 'impl',
    generics,
    unsafe,
    negative,
    trait: traitTokens === null ? null : fragmentOf(traitTokens),
    selfTy: fragmentOf(selfTokens),
    where,
    innerAttrs: block.innerAttrs,
    items: block.items,
  };
}

/** `unsafe trait`, `unsafe impl`, or `auto trait`. */
function isQualifiedTraitOrImpl(c: TreeCursor): boolean {
  if (isWord(c.peek(1), 'trait')) return true;
  return isWord(c.peek(), 'unsafe') && isWord(c.peek(1), 'impl');
}

function parseQualifiedTraitOrImpl(
  c: TreeCursor,
  errors: RustLexNote[],
  keyword: string,
): ItemBody {
  const unsafe = keyword === 'unsafe';
  c.next();
  if (isWord(c.peek(), 'impl')) return parseImpl(c, errors, true);
  return parseTrait(c, errors, { unsafe, auto: !unsafe });
}

// ── Macros and extern items (V3 Phase 6.3d) ─────────────────

function parseMacroRules(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  c.next(); // macro_rules
  c.next(); // !
  const name = identName(c.peek());
  if (name === undefined) {
    fail(errors, c, 'expected a macro name');
    skipUnknownItem(c);
    return { kind: 'unknown', keyword: 'macro_rules' };
  }
  c.next();
  const body = groupOf(c.peek(), '{') ?? groupOf(c.peek(), '(') ?? groupOf(c.peek(), '[');
  if (!body) {
    fail(errors, c, 'expected a macro body');
    skipUnknownItem(c);
    return { kind: 'unknown', keyword: 'macro_rules' };
  }
  c.next();
  if (body.delimiter !== '{') {
    if (isPunct(c.peek(), ';')) c.next();
    else fail(errors, c, 'expected `;` after macro definition');
  }
  return { kind: 'macro_rules', name, body };
}

/** A path, then `!`, then a delimited group: `name! { … }`, `a::b!(…);`. */
function isMacroCallStart(c: TreeCursor): boolean {
  let offset = 0;
  if (identName(c.peek(offset)) === undefined) return false;
  offset += 1;
  while (isPunct(c.peek(offset), '::') && identName(c.peek(offset + 1)) !== undefined) {
    offset += 2;
  }
  if (!isPunct(c.peek(offset), '!')) return false;
  const args = c.peek(offset + 1);
  return args !== undefined && isTokenGroup(args);
}

function parseMacroCall(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  const path: string[] = [];
  for (;;) {
    const name = identName(c.peek());
    if (name === undefined) break;
    path.push(name);
    c.next();
    if (!isPunct(c.peek(), '::')) break;
    c.next();
  }
  c.next(); // !
  const args = c.next();
  if (args === undefined || !isTokenGroup(args)) {
    return { kind: 'unknown', keyword: path.join('::') };
  }
  // A brace-delimited invocation needs no `;`.
  if (args.delimiter !== '{') {
    if (isPunct(c.peek(), ';')) c.next();
    else fail(errors, c, 'expected `;` after macro invocation');
  }
  return { kind: 'macro_call', path: path.join('::'), delimiter: args.delimiter, args };
}

function parseExternCrate(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  c.next(); // extern
  c.next(); // crate
  const name = identName(c.peek());
  if (name === undefined) {
    fail(errors, c, 'expected a crate name');
    skipUnknownItem(c);
    return { kind: 'unknown', keyword: 'extern' };
  }
  c.next();
  let alias: string | null = null;
  if (isWord(c.peek(), 'as')) {
    c.next();
    const aliasName = identName(c.peek());
    if (aliasName === undefined) {
      fail(errors, c, 'expected a name after `as`');
    } else {
      c.next();
      alias = aliasName;
    }
  }
  if (isPunct(c.peek(), ';')) c.next();
  else fail(errors, c, 'expected `;` after extern crate');
  return { kind: 'extern_crate', name, alias };
}

/** `extern "ABI" { … }`, or `extern { … }`. `extern "ABI" fn` is a function (see `isFnStart`). */
function parseExternBlock(c: TreeCursor, errors: RustLexNote[]): ItemBody {
  c.next(); // extern
  let abi: string | null = null;
  const literal = c.peek();
  if (literal !== undefined && !isTokenGroup(literal) && literal.kind === 'str') {
    abi = literal.text;
    c.next();
  }
  const block = parseBlock(c, errors);
  if (!block) return { kind: 'unknown', keyword: 'extern' };
  return { kind: 'extern_block', abi, innerAttrs: block.innerAttrs, items: block.items };
}
