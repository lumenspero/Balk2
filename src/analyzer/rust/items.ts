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
  const body: ItemBody =
    keyword === 'use'
      ? parseUse(c, errors)
      : keyword === 'mod'
        ? parseMod(c, errors)
        : parseUnknown(c, keyword);
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
