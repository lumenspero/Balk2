/**
 * Items declared inside function bodies (V3 Phase 9.8). A nested item is named under its function
 * (`file:outer::inner`). Its calls and references belong to it, not to the function around it, and
 * its names are visible only inside the block where it is written.
 *
 * Only items are read. A statement is an item when it starts with an item keyword (after any
 * attributes, `pub`, `unsafe` and `const fn`) at a statement start. `mod` items are not read.
 */
import { type BodyFact, scanFunctionBody } from './body.js';
import { type Item, parseItems, type Span, TreeCursor } from './items.js';
import type { RustLexNote } from './lexer.js';
import { isTokenGroup, type TokenGroup, type TokenTree } from './token-tree.js';

const ITEM_KEYWORDS: ReadonlySet<string> = new Set([
  'fn',
  'struct',
  'enum',
  'union',
  'trait',
  'impl',
  'type',
  'static',
  'const',
  'use',
  'mod',
]);

/** Items that end at their closing brace. The others end at a `;`. */
const BRACED: ReadonlySet<string> = new Set([
  'fn',
  'struct',
  'enum',
  'union',
  'trait',
  'impl',
  'mod',
]);

const cache = new WeakMap<TokenGroup, Item[]>();

/** The items declared directly in a function body, as the parser reads them. Cached per body. */
export function nestedItemsOf(body: TokenGroup | null): Item[] {
  if (body === null) return [];
  const cached = cache.get(body);
  if (cached !== undefined) return cached;
  const trees = body.children;
  const items: Item[] = [];
  let i = 0;
  while (i < trees.length) {
    const keyword = i === 0 || startsStatement(trees[i - 1]) ? itemKeywordAt(trees, i) : null;
    if (keyword === null) {
      i += 1;
      continue;
    }
    const end = itemEnd(trees, keyword);
    const errors: RustLexNote[] = [];
    const parsed = parseItems(new TreeCursor(trees.slice(i, end + 1)), errors).items;
    for (const item of parsed) {
      if (item.kind !== 'mod' && item.kind !== 'unknown') items.push(item);
    }
    i = end + 1;
  }
  cache.set(body, items);
  return items;
}

/** The facts of a function body that are not inside one of its nested items. */
export function ownBodyFacts(body: TokenGroup): BodyFact[] {
  const nested = nestedItemsOf(body);
  const facts = scanFunctionBody(body);
  if (nested.length === 0) return facts;
  return facts.filter((fact) => !nested.some((item) => startsWithin(fact.span, item.span)));
}

/** The scope key of the block that holds a function's nested items. */
export function blockKey(fnId: string): string {
  return `${fnId}{body}`;
}

function startsStatement(previous: TokenTree | undefined): boolean {
  if (previous === undefined) return true;
  if (isTokenGroup(previous)) return previous.delimiter === '{';
  return previous.kind === 'punct' && previous.text === ';';
}

/** The index of the item keyword that starts an item at `i`, or null when the tokens there are not an item. */
function itemKeywordAt(trees: readonly TokenTree[], i: number): number | null {
  let j = i;
  while (isPunct(trees[j], '#')) {
    const group = trees[j + 1];
    if (group === undefined || !isTokenGroup(group) || group.delimiter !== '[') return null;
    j += 2;
  }
  while (isWord(trees[j], 'pub') || isWord(trees[j], 'unsafe')) j += 1;
  const word = trees[j];
  if (word === undefined || isTokenGroup(word) || word.kind !== 'ident') return null;
  if (!ITEM_KEYWORDS.has(word.value)) return null;
  const next = trees[j + 1];
  // `const {` and `static ||` are expressions, not items, and a bare `union` is a name.
  if (word.value === 'const' || word.value === 'static') {
    if (next === undefined || isTokenGroup(next) || next.kind !== 'ident') return null;
  }
  if (
    word.value === 'union' &&
    (next === undefined || isTokenGroup(next) || next.kind !== 'ident')
  ) {
    return null;
  }
  return j;
}

/** The index of the token that ends the item whose keyword is at `keyword`, inclusive. */
function itemEnd(trees: readonly TokenTree[], keyword: number): number {
  const word = trees[keyword];
  const braced = word !== undefined && !isTokenGroup(word) && BRACED.has(word.value);
  for (let k = keyword + 1; k < trees.length; k += 1) {
    const tree = trees[k];
    if (isPunct(tree, ';')) return k;
    if (braced && tree !== undefined && isTokenGroup(tree) && tree.delimiter === '{') return k;
  }
  return trees.length - 1;
}

function isPunct(tree: TokenTree | undefined, text: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'punct' && tree.text === text;
}

function isWord(tree: TokenTree | undefined, word: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'ident' && tree.value === word;
}

/** True when a span starts inside another. */
function startsWithin(inner: Span, outer: Span): boolean {
  const afterStart =
    inner.line > outer.line || (inner.line === outer.line && inner.column >= outer.column);
  const beforeEnd =
    inner.line < outer.endLine || (inner.line === outer.endLine && inner.column <= outer.endColumn);
  return afterStart && beforeEnd;
}
