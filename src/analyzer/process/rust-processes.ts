import type { RustToken } from '../rust/lexer.js';
import type { Item, RustFile } from '../rust/items.js';
import { isTokenGroup, type TokenGroup, type TokenTree } from '../rust/token-tree.js';
import type { ProcessCall } from './types.js';

/**
 * The process-execution calls in Rust (V3 Phase 14.5): `Command::new(program)` with any chain of
 * `.arg(...)` and `.args([...])` in a function body. Each call's owner is its enclosing function.
 * A call with a non-literal program or argument is an observation.
 */
export function rustProcesses(files: ReadonlyMap<string, RustFile>): ProcessCall[] {
  const calls: ProcessCall[] = [];
  for (const [file, parsed] of files) visitItems(parsed.items, file, calls);
  return calls;
}

function visitItems(items: readonly Item[], file: string, calls: ProcessCall[]): void {
  for (const item of items) {
    if (item.kind === 'fn' && item.body !== null) {
      scan(item.body.children, `${file}:${item.name}`, file, calls);
    } else if (item.kind === 'mod' || item.kind === 'impl' || item.kind === 'trait') {
      visitItems(item.items, file, calls);
    }
  }
}

/** Finds `Command::new` at this level and recurses into every group. */
function scan(
  trees: readonly TokenTree[],
  owner: string,
  file: string,
  calls: ProcessCall[],
): void {
  for (let at = 0; at < trees.length; at++) {
    const tree = trees[at];
    if (tree === undefined) continue;
    if (isTokenGroup(tree)) {
      scan(tree.children, owner, file, calls);
      continue;
    }
    if (!isWord(tree, 'Command')) continue;
    const last = commandAt(trees, at, owner, file, calls);
    if (last !== undefined) at = last;
  }
}

/** Reads one `Command::new(...)` with its chain. Returns the index of the last tree it used. */
function commandAt(
  trees: readonly TokenTree[],
  at: number,
  owner: string,
  file: string,
  calls: ProcessCall[],
): number | undefined {
  const head = trees[at];
  const separator = trees[at + 1];
  const constructor = trees[at + 2];
  const open = trees[at + 3];
  if (
    head === undefined ||
    isTokenGroup(head) ||
    !isPunct(separator, '::') ||
    !isWord(constructor, 'new') ||
    open === undefined ||
    !isGroup(open, '(')
  ) {
    return undefined;
  }

  let argv: string[] | null = program(open);
  let last: TokenTree = open;
  let cursor = at + 4;
  for (;;) {
    const dot = trees[cursor];
    const method = trees[cursor + 1];
    const group = trees[cursor + 2];
    if (
      !isPunct(dot, '.') ||
      !isWord(method) ||
      (method.value !== 'arg' && method.value !== 'args') ||
      group === undefined ||
      !isGroup(group, '(')
    ) {
      break;
    }
    cursor += 3;
    last = group;
    if (argv !== null) {
      const more = method.value === 'arg' ? program(group) : argumentList(group);
      argv = more === null ? null : [...argv, ...more];
    }
  }

  calls.push({
    file,
    owner,
    callee: 'Command::new',
    argv,
    span: {
      filePath: file,
      startLine: head.line,
      startColumn: head.column,
      endLine: last.endLine,
      endColumn: last.endColumn,
    },
  });
  return cursor - 1;
}

/** The single string literal a `(...)` group holds, as a one-item argv, or null. */
function program(group: TokenGroup): string[] | null {
  const value = singleString(group);
  return value === undefined ? null : [value];
}

/** The string literal in a `(...)` group, ignoring a leading `&`. Undefined when not a literal. */
function singleString(group: TokenGroup): string | undefined {
  const items = argumentTrees(group);
  const [only] = items;
  if (items.length !== 1 || only === undefined || isTokenGroup(only) || only.kind !== 'str') {
    return undefined;
  }
  return unquote(only.text);
}

/** The strings of a `(...)` group holding an array literal, or null when any item is not one. */
function argumentList(group: TokenGroup): string[] | null {
  const items = argumentTrees(group);
  if (items.length === 0) return [];
  const [array] = items;
  if (items.length !== 1 || array === undefined || !isGroup(array, '[')) return null;
  const values: string[] = [];
  for (const element of array.children) {
    if (isPunct(element, ',')) continue;
    if (isTokenGroup(element) || element.kind !== 'str') return null;
    const value = unquote(element.text);
    if (value === undefined) return null;
    values.push(value);
  }
  return values;
}

/** The trees inside a group, with a leading `&` dropped. */
function argumentTrees(group: TokenGroup): readonly TokenTree[] {
  const [first, ...rest] = group.children;
  return first !== undefined && isPunct(first, '&') ? rest : group.children;
}

/** The value of a plain or raw string literal. Escapes are not read, so they make it undefined. */
function unquote(text: string): string | undefined {
  const raw = /^r(#*)"([\s\S]*)"\1$/.exec(text);
  if (raw !== null) return raw[2] ?? '';
  const plain = /^"([\s\S]*)"$/.exec(text);
  if (plain === null) return undefined;
  const inner = plain[1] ?? '';
  return inner.includes('\\') ? undefined : inner;
}

function isWord(tree: TokenTree | undefined, word?: string): tree is RustToken {
  return (
    tree !== undefined &&
    !isTokenGroup(tree) &&
    tree.kind === 'ident' &&
    (word === undefined || tree.value === word)
  );
}

function isPunct(tree: TokenTree | undefined, text: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'punct' && tree.text === text;
}

function isGroup(tree: TokenTree | undefined, delimiter: '(' | '[' | '{'): tree is TokenGroup {
  return tree !== undefined && isTokenGroup(tree) && tree.delimiter === delimiter;
}
