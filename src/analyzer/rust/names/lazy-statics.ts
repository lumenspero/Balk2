/**
 * The statics inside a `lazy_static!` block (V3 Phase 12.2 and 12.3): each `static [ref] NAME: TYPE
 * = VALUE;`. The registry and state passes both read them from here.
 */
import { isTokenGroup, type TokenTree } from '../token-tree.js';

export interface LazyStatic {
  readonly name: string;
  /** The declared type's tokens */
  readonly type: readonly TokenTree[];
  /** The initializer's tokens */
  readonly tokens: readonly TokenTree[];
}

/** The `static [ref] NAME: TYPE = VALUE;` items inside a `lazy_static!` block. */
export function lazyStaticsOf(trees: readonly TokenTree[]): LazyStatic[] {
  const out: LazyStatic[] = [];
  let i = 0;
  while (i < trees.length) {
    if (!isWord(trees[i], 'static')) {
      i += 1;
      continue;
    }
    let j = i + 1;
    if (isWord(trees[j], 'ref')) j += 1;
    const name = trees[j];
    if (name === undefined || isTokenGroup(name) || name.kind !== 'ident') {
      i = j;
      continue;
    }
    j += 1;
    if (!isPunct(trees[j], ':')) {
      i = j;
      continue;
    }
    const typeStart = j + 1;
    while (j < trees.length && !isPunct(trees[j], '=')) j += 1;
    if (j >= trees.length) break;
    const type = trees.slice(typeStart, j);
    j += 1;
    const start = j;
    while (j < trees.length && !isPunct(trees[j], ';')) j += 1;
    out.push({ name: name.value, type, tokens: trees.slice(start, j) });
    i = j + 1;
  }
  return out;
}

function isWord(tree: TokenTree | undefined, word: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'ident' && tree.value === word;
}

function isPunct(tree: TokenTree | undefined, text: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'punct' && tree.text === text;
}
