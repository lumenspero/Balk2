/**
 * Rust token trees (V3 Phase 6.2).
 *
 * A token tree is either one token or a `()`, `[]` or `{}` group holding further
 * token trees. Positions are 1-based, as in the lexer. Building never throws. Each
 * mismatch produces a note and is recovered as follows:
 *
 * - A closing delimiter with no matching opener is kept as a plain token.
 * - A closing delimiter that matches an outer opener closes the openers inside it.
 *   Each of those is noted as unclosed, in source order.
 * - An opener still open at the end of the input is noted and closed with no closer.
 *
 * Item-boundary recovery needs item structure, so it belongs to the item parser (6.3).
 */

import type { RustLexNote, RustToken } from './lexer.js';

export type Delimiter = '(' | '[' | '{';

export interface TokenGroup {
  readonly delimiter: Delimiter;
  readonly open: RustToken;
  /** The matching closer, or `null` when the group is unclosed. */
  readonly close: RustToken | null;
  readonly children: readonly TokenTree[];
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  /** Set when this group holds the arguments of a configured expression macro (`rust.macros.expressionLike`). */
  readonly codeArguments?: boolean;
}

export type TokenTree = RustToken | TokenGroup;

/** Options for building token trees. */
export interface TokenTreeOptions {
  /**
   * Macro names, as written before `!`, whose arguments are code (V3 Phase 15.3,
   * `rust.macros.expressionLike`). Their groups are marked with `codeArguments`.
   */
  readonly expressionMacros?: ReadonlySet<string>;
}

export interface TokenTreeResult {
  readonly trees: readonly TokenTree[];
  readonly errors: readonly RustLexNote[];
}

const OPENER_FOR: Readonly<Record<string, Delimiter>> = { ')': '(', ']': '[', '}': '{' };

export function isTokenGroup(tree: TokenTree): tree is TokenGroup {
  return 'delimiter' in tree;
}

/** The delimiter this token opens, if any. */
function opens(token: RustToken): Delimiter | undefined {
  if (token.kind !== 'punct') return undefined;
  if (token.text === '(' || token.text === '[' || token.text === '{') return token.text;
  return undefined;
}

/** The delimiter this token closes, if any. */
function closes(token: RustToken): Delimiter | undefined {
  if (token.kind !== 'punct') return undefined;
  return OPENER_FOR[token.text];
}

/**
 * True when the group about to close follows `name!` and `name` is a configured expression macro.
 * `parent` holds the trees already closed at this level, so the group's prefix is its last two.
 */
function isConfiguredMacroArguments(
  parent: readonly TokenTree[],
  expressionMacros: ReadonlySet<string>,
): boolean {
  if (expressionMacros.size === 0) return false;
  const bang = parent.at(-1);
  const name = parent.at(-2);
  return (
    bang !== undefined &&
    !isTokenGroup(bang) &&
    bang.kind === 'punct' &&
    bang.text === '!' &&
    name !== undefined &&
    !isTokenGroup(name) &&
    name.kind === 'ident' &&
    expressionMacros.has(name.value)
  );
}

interface Frame {
  readonly delimiter: Delimiter;
  readonly open: RustToken;
  readonly children: TokenTree[];
}

/** Builds token trees from a lexer token stream. The endmarker is not part of the result. */
export function buildTokenTrees(
  tokens: readonly RustToken[],
  options: TokenTreeOptions = {},
): TokenTreeResult {
  const expressionMacros: ReadonlySet<string> = options.expressionMacros ?? new Set<string>();
  const root: TokenTree[] = [];
  const stack: Frame[] = [];
  const errors: RustLexNote[] = [];

  const current = (): TokenTree[] => stack.at(-1)?.children ?? root;

  const noteUnclosed = (frame: Frame): void => {
    errors.push({
      message: `unclosed \`${frame.delimiter}\``,
      line: frame.open.line,
      column: frame.open.column,
    });
  };

  // The group is added to its parent when it closes, so the parent's order is preserved.
  const closeTop = (closer: RustToken | null): void => {
    const frame = stack.pop();
    if (!frame) return;
    const end = closer ?? frame.children.at(-1) ?? frame.open;
    const parent = current();
    parent.push({
      delimiter: frame.delimiter,
      open: frame.open,
      close: closer,
      children: frame.children,
      line: frame.open.line,
      column: frame.open.column,
      endLine: end.endLine,
      endColumn: end.endColumn,
      ...(isConfiguredMacroArguments(parent, expressionMacros) ? { codeArguments: true } : {}),
    });
  };

  for (const token of tokens) {
    if (token.kind === 'endmarker') continue;

    const opener = opens(token);
    if (opener) {
      stack.push({ delimiter: opener, open: token, children: [] });
      continue;
    }

    const expected = closes(token);
    if (!expected) {
      current().push(token);
      continue;
    }

    const match = stack.map((frame) => frame.delimiter).lastIndexOf(expected);
    if (match < 0) {
      errors.push({
        message: `unmatched \`${token.text}\``,
        line: token.line,
        column: token.column,
      });
      current().push(token);
      continue;
    }

    for (const inner of stack.slice(match + 1)) noteUnclosed(inner);
    while (stack.length - 1 > match) closeTop(null);
    closeTop(token);
  }

  for (const frame of stack) noteUnclosed(frame);
  while (stack.length > 0) closeTop(null);

  return { trees: root, errors };
}
