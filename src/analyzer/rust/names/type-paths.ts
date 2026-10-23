/**
 * Paths read from the token trees of a type, bound, or trait (V3 Phase 9.5). A path is the
 * identifiers separated by `::`, with generic arguments dropped. A leading `::` makes it global.
 * `dyn`, `impl`, `mut` and `const` are skipped. Anything else, such as `&T`, `[T]`, a tuple or a
 * lifetime, names no single path and gives null.
 */
import type { TokenTree } from '../token-tree.js';
import { isTokenGroup } from '../token-tree.js';
import type { RustPath } from './resolve.js';

const SKIPPED_WORDS: ReadonlySet<string> = new Set(['dyn', 'impl', 'mut', 'const']);

/** The path a token list names, or null when it names none. */
export function pathOfTokens(trees: readonly TokenTree[]): RustPath | null {
  return readPath(trees).path;
}

/**
 * The path at the start of a token list, and the index of the first token after it. The path is
 * null when the list does not start with one. Used where the token after a path matters, as in
 * `Path { .. }` or `Path(..)`.
 */
export function readPath(trees: readonly TokenTree[]): { path: RustPath | null; end: number } {
  let global = false;
  let start = 0;
  const [first] = trees;
  if (
    first !== undefined &&
    !isTokenGroup(first) &&
    first.kind === 'punct' &&
    first.text === '::'
  ) {
    global = true;
    start = 1;
  }
  const segments: string[] = [];
  let end = start;
  for (let k = start; k < trees.length; k++) {
    const tree = trees[k];
    if (tree === undefined || isTokenGroup(tree)) break;
    if (tree.kind === 'ident') {
      if (tree.value === 'for' || tree.value === 'where') break;
      if (!SKIPPED_WORDS.has(tree.value)) segments.push(tree.value);
      end = k + 1;
      continue;
    }
    if (tree.kind === 'punct' && tree.text === '::') {
      end = k + 1;
      continue;
    }
    break;
  }
  return { path: segments.length === 0 ? null : { global, segments }, end };
}

/** Splits a bound list such as `Base + Send + 'static` at its top-level `+`. */
export function splitBounds(trees: readonly TokenTree[]): TokenTree[][] {
  const out: TokenTree[][] = [[]];
  let depth = 0;
  for (const tree of trees) {
    if (!isTokenGroup(tree) && tree.kind === 'punct') {
      if (tree.text === '+' && depth === 0) {
        out.push([]);
        continue;
      }
      if (tree.text === '<') depth += 1;
      else if (tree.text === '<<') depth += 2;
      else if (tree.text === '>') depth = Math.max(0, depth - 1);
      else if (tree.text === '>>') depth = Math.max(0, depth - 2);
    }
    out[out.length - 1]?.push(tree);
  }
  return out;
}
