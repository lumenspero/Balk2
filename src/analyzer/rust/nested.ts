/**
 * Items declared inside function bodies and const or static values (V3 Phase 9.8). A nested item is
 * named under its owner (`file:outer::inner`, `file:C::inner` for a const). Its calls and references
 * belong to it, not to the function around it, and its names are visible only inside the `{ }` block
 * where it is written, and the blocks in that block.
 *
 * Only items are read. A statement is an item when it starts with an item keyword (after any
 * attributes, `pub`, `unsafe`) at a statement start. `mod` items are not read.
 */
import { type BodyFact, macroArgumentsAreCode, scanFunctionBody } from './body.js';
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
  'extern',
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
  'extern',
]);

/** A `{ }` block that declares items. Blocks are listed outermost first. */
export interface BodyBlock {
  /** The block's position in its file. With the owner's id, it names the block's scope. */
  readonly position: string;
  readonly span: Span;
  readonly items: readonly Item[];
  /** The nearest enclosing block that declares items, or null. */
  readonly parent: BodyBlock | null;
  /** True for a function's own body. */
  readonly top: boolean;
}

const itemCache = new WeakMap<TokenGroup, Item[]>();
const blockCache = new WeakMap<object, BodyBlock[]>();

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
  return blocksWithin(body, body.children, true);
}

/** The blocks of a const or static value that declare items. Cached per value. */
export function blocksOfTokens(trees: readonly TokenTree[]): BodyBlock[] {
  return blocksWithin(null, trees, false);
}

/** The facts of a function body that are not inside one of its nested items. */
export function ownBodyFacts(body: TokenGroup): BodyFact[] {
  return factsOutside(scanFunctionBody(body), bodyBlocksOf(body));
}

/** The facts that are not inside an item of one of the blocks. */
export function factsOutside(facts: readonly BodyFact[], blocks: readonly BodyBlock[]): BodyFact[] {
  const nested = blocks.flatMap((block) => block.items);
  if (nested.length === 0) return [...facts];
  return facts.filter((fact) => !nested.some((item) => startsWithin(fact.span, item.span)));
}

/** The scope key of a block: its owner's id and the block's position. */
export function blockKey(ownerId: string, position: string): string {
  return `${ownerId}{${position}}`;
}

/** True when a span starts inside another. */
export function startsWithin(inner: Span, outer: Span): boolean {
  const afterStart =
    inner.line > outer.line || (inner.line === outer.line && inner.column >= outer.column);
  const beforeEnd =
    inner.line < outer.endLine || (inner.line === outer.endLine && inner.column <= outer.endColumn);
  return afterStart && beforeEnd;
}

function blocksWithin(
  self: TokenGroup | null,
  trees: readonly TokenTree[],
  top: boolean,
): BodyBlock[] {
  const key: object = self ?? trees;
  const cached = blockCache.get(key);
  if (cached !== undefined) return cached;
  const blocks: BodyBlock[] = [];
  collectBlocks(self, trees, null, blocks, top);
  blockCache.set(key, blocks);
  return blocks;
}

function collectBlocks(
  self: TokenGroup | null,
  trees: readonly TokenTree[],
  enclosing: BodyBlock | null,
  out: BodyBlock[],
  top: boolean,
): void {
  // Only a `{ }` group is a block. A value's own tokens are not, so they declare no items.
  const items = self !== null && self.delimiter === '{' ? nestedItemsOf(self) : [];
  let here = enclosing;
  if (self !== null && items.length > 0) {
    here = {
      position: `${self.line}:${self.column}`,
      span: spanOf(self),
      items,
      parent: enclosing,
      top,
    };
    out.push(here);
  }
  for (let index = 0; index < trees.length; index += 1) {
    const child = trees[index];
    if (child === undefined || !isTokenGroup(child)) continue;
    // A group inside a nested item belongs to that item, not to this block.
    const childSpan = spanOf(child);
    if (items.some((item) => startsWithin(childSpan, item.span))) continue;
    // A macro's template arguments, such as a `quote!` body or a `macro_rules!` definition, are not code.
    if (isTemplateArgument(trees, index)) continue;
    collectBlocks(child, child.children, here, out, false);
  }
}

/** True for the group after `name!` when the macro's arguments are not code, or the body of `macro_rules! name`. */
function isTemplateArgument(trees: readonly TokenTree[], index: number): boolean {
  if (index >= 3 && isWord(trees[index - 3], 'macro_rules') && isPunct(trees[index - 2], '!')) {
    return true;
  }
  if (!isPunct(trees[index - 1], '!')) return false;
  const name = trees[index - 2];
  if (name === undefined || isTokenGroup(name) || name.kind !== 'ident') return false;
  const args = trees[index];
  return !macroArgumentsAreCode(
    name.value,
    args !== undefined && isTokenGroup(args) ? args : undefined,
  );
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
  if (word.value === 'extern') {
    // `extern "C" { }`, `extern { }`, `extern "C" fn` and `extern crate`. Nothing else starts an item here.
    if (next === undefined) return null;
    if (isTokenGroup(next)) return next.delimiter === '{' ? j : null;
    return next.kind === 'str' || next.kind === 'ident' ? j : null;
  }
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
