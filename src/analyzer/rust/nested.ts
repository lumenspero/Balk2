/**
 * Items declared inside function bodies (V3 Phase 9.8). A nested item is named under its function
 * (`file:outer::inner`). Its calls and references belong to it, not to the function around it, and
 * its names are visible only inside the `{ }` block where it is written, and the blocks in that block.
 *
 * Only items are read. A statement is an item when it starts with an item keyword (after any
 * attributes, `pub`, `unsafe`) at a statement start. `mod` items are not read.
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

/** A `{ }` block that declares items. Blocks are listed outermost first. */
export interface BodyBlock {
  /** The block's position in its file. With the function id, it names the block's scope. */
  readonly position: string;
  readonly span: Span;
  readonly items: readonly Item[];
  /** The nearest enclosing block that declares items, or null. */
  readonly parent: BodyBlock | null;
  /** True for the function's own body. */
  readonly top: boolean;
}

const itemCache = new WeakMap<TokenGroup, Item[]>();
const blockCache = new WeakMap<TokenGroup, BodyBlock[]>();

/** The items declared directly in a group's statements, as the parser reads them. Cached per group. */
export function nestedItemsOf(group: TokenGroup | null): Item[] {
  if (group === null) return [];
  const cached = itemCache.get(group);
  if (cached !== undefined) return cached;
  const trees = group.children;
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
  itemCache.set(group, items);
  return items;
}

/** The blocks of a function body that declare items, including blocks inside other blocks. Cached per body. */
export function bodyBlocksOf(body: TokenGroup): BodyBlock[] {
  const cached = blockCache.get(body);
  if (cached !== undefined) return cached;
  const blocks: BodyBlock[] = [];
  collectBlocks(body, null, blocks, true);
  blockCache.set(body, blocks);
  return blocks;
}

/** The facts of a function body that are not inside one of its nested items. */
export function ownBodyFacts(body: TokenGroup): BodyFact[] {
  const nested = bodyBlocksOf(body).flatMap((block) => block.items);
  const facts = scanFunctionBody(body);
  if (nested.length === 0) return facts;
  return facts.filter((fact) => !nested.some((item) => startsWithin(fact.span, item.span)));
}

/** The scope key of a block: its function's id and the block's position. */
export function blockKey(fnId: string, position: string): string {
  return `${fnId}{${position}}`;
}

/** True when a span starts inside another. */
export function startsWithin(inner: Span, outer: Span): boolean {
  const afterStart =
    inner.line > outer.line || (inner.line === outer.line && inner.column >= outer.column);
  const beforeEnd =
    inner.line < outer.endLine || (inner.line === outer.endLine && inner.column <= outer.endColumn);
  return afterStart && beforeEnd;
}

function collectBlocks(
  group: TokenGroup,
  enclosing: BodyBlock | null,
  out: BodyBlock[],
  top: boolean,
): void {
  const items = group.delimiter === '{' ? nestedItemsOf(group) : [];
  let here = enclosing;
  if (items.length > 0) {
    here = {
      position: `${group.line}:${group.column}`,
      span: spanOf(group),
      items,
      parent: enclosing,
      top,
    };
    out.push(here);
  }
  for (const child of group.children) {
    if (!isTokenGroup(child)) continue;
    // A group inside a nested item belongs to that item, not to this block.
    const childSpan = spanOf(child);
    if (items.some((item) => startsWithin(childSpan, item.span))) continue;
    collectBlocks(child, here, out, false);
  }
}

function spanOf(group: TokenGroup): Span {
  return {
    line: group.line,
    column: group.column,
    endLine: group.endLine,
    endColumn: group.endColumn,
  };
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
  if (word.value === 'const' || word.value === 'static' || word.value === 'union') {
    if (next === undefined || isTokenGroup(next) || next.kind !== 'ident') return null;
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
