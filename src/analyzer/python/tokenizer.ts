/**
 * Python tokenizer (V3 Phase 3.1, first increment).
 *
 * Positions are 1-based, the same convention as SourceSpan. Columns count
 * UTF-16 code units, as the TypeScript front end does. Comments and the
 * encoding declaration are trivia: they are returned beside the token stream,
 * never inside it. Tokenizing never throws; malformed input produces notes.
 */

export type TokenKind =
  | 'name'
  | 'keyword'
  | 'number'
  | 'string'
  | 'op'
  | 'newline'
  | 'nl'
  | 'indent'
  | 'dedent'
  | 'endmarker'
  | 'error';

export interface Token {
  readonly kind: TokenKind;
  readonly value: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface TokenizeNote {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export interface CommentTrivia {
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

export interface TokenizeResult {
  readonly tokens: readonly Token[];
  readonly comments: readonly CommentTrivia[];
  readonly encoding?: string;
  readonly errors: readonly TokenizeNote[];
}

/** The 35 hard keywords. Soft keywords (`match`, `case`, `type`, `_`) are names. */
export const HARD_KEYWORDS: ReadonlySet<string> = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
]);

/** Longest first, so the first match is always the longest operator. */
const OPERATORS: readonly string[] = [
  '**=',
  '//=',
  '>>=',
  '<<=',
  '...',
  '->',
  '**',
  '//',
  '<<',
  '>>',
  '<=',
  '>=',
  '==',
  '!=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '@=',
  ':=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '@',
  '&',
  '|',
  '^',
  '~',
  '<',
  '>',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ',',
  ':',
  '.',
  ';',
  '=',
];

const CLOSER_OF: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

/** Prefixes for string literals, lowercased. `t` is the 3.14 template string. */
const STRING_PREFIXES: ReadonlySet<string> = new Set([
  'r',
  'u',
  'b',
  'br',
  'rb',
  'f',
  'fr',
  'rf',
  't',
  'tr',
  'rt',
]);

const NUMBER =
  /(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|(?:\d(?:_?\d)*)?\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?|\d(?:_?\d)*\.?(?:[eE][+-]?\d(?:_?\d)*)?)[jJ]?/y;
const IDENTIFIER = /[\p{XID_Start}_][\p{XID_Continue}]*/uy;
const ENCODING = /^#.*?coding[:=][ \t]*([-\w.]+)/;

/** The innermost indentation level. The stack never empties: its base level is column 0. */
const currentIndent = (
  stack: ReadonlyArray<{ col: number; alt: number }>,
): { col: number; alt: number } => stack[stack.length - 1] ?? { col: 0, alt: 0 };

const identifierAt = (text: string, p: number): string | undefined => {
  IDENTIFIER.lastIndex = p;
  const match = IDENTIFIER.exec(text);
  return match ? match[0] : undefined;
};

export function tokenize(source: string): TokenizeResult {
  const text = source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
  const tokens: Token[] = [];
  const comments: CommentTrivia[] = [];
  const errors: TokenizeNote[] = [];
  const indents: Array<{ col: number; alt: number }> = [{ col: 0, alt: 0 }];
  const brackets: Array<{ char: string; line: number; column: number }> = [];
  let encoding: string | undefined;
  let pos = 0;
  let line = 1;
  let lineStart = 0;
  let atLineStart = true;
  let lineHasCode = false;

  const col = (p: number): number => p - lineStart + 1;

  const note = (message: string, l: number, c: number): void => {
    errors.push({ message, line: l, column: c });
  };

  const push = (
    kind: TokenKind,
    value: string,
    sl: number,
    sc: number,
    el: number,
    ec: number,
  ): void => {
    tokens.push({ kind, value, line: sl, column: sc, endLine: el, endColumn: ec });
    if (
      kind !== 'indent' &&
      kind !== 'dedent' &&
      kind !== 'nl' &&
      kind !== 'newline' &&
      kind !== 'endmarker'
    ) {
      lineHasCode = true;
    }
  };

  /** Length of the line break at p (CRLF, LF or CR), or 0 when p is not a line break. */
  const newlineLength = (p: number): number => {
    const ch = text.charAt(p);
    if (ch === '\r') return text.charAt(p + 1) === '\n' ? 2 : 1;
    return ch === '\n' ? 1 : 0;
  };

  const scanString = (start: number, quotePos: number): void => {
    const quote = text.charAt(quotePos);
    const triple = text.startsWith(quote.repeat(3), quotePos);
    const delim = triple ? quote.repeat(3) : quote;
    const startLine = line;
    const startCol = col(start);
    let p = quotePos + delim.length;
    let closed = false;
    while (p < text.length) {
      const c = text.charAt(p);
      if (c === '\\') {
        const n = newlineLength(p + 1);
        if (n > 0) {
          line += 1;
          lineStart = p + 1 + n;
          p += 1 + n;
        } else {
          p += 2;
        }
        continue;
      }
      if (c === quote && text.startsWith(delim, p)) {
        p += delim.length;
        closed = true;
        break;
      }
      const n = newlineLength(p);
      if (n > 0) {
        if (!triple) break;
        line += 1;
        lineStart = p + n;
        p += n;
        continue;
      }
      p += 1;
    }
    if (!closed) {
      note(
        triple ? 'unterminated triple-quoted string literal' : 'unterminated string literal',
        startLine,
        startCol,
      );
    }
    push(
      closed ? 'string' : 'error',
      text.slice(start, Math.min(p, text.length)),
      startLine,
      startCol,
      line,
      col(p),
    );
    pos = p;
  };

  while (pos < text.length) {
    if (atLineStart && brackets.length === 0) {
      let p = pos;
      let c = 0;
      let a = 0;
      for (;;) {
        const ch = text.charAt(p);
        if (ch === ' ') {
          c += 1;
          a += 1;
        } else if (ch === '\t') {
          c = (Math.floor(c / 8) + 1) * 8;
          a += 1;
        } else if (ch === '\f') {
          c = 0;
          a = 0;
        } else {
          break;
        }
        p += 1;
      }
      pos = p;
      if (p >= text.length) break;
      if (newlineLength(p) === 0 && text.charAt(p) !== '#') {
        // A code line: compare its indentation with the stack.
        const top = currentIndent(indents);
        const here = col(p);
        if (c > top.col) {
          if (a <= top.alt) {
            note('inconsistent use of tabs and spaces in indentation', line, here);
          }
          indents.push({ col: c, alt: a });
          push('indent', '', line, 1, line, here);
        } else {
          while (c < currentIndent(indents).col) {
            indents.pop();
            push('dedent', '', line, here, line, here);
          }
          const after = currentIndent(indents);
          if (c !== after.col) {
            note('unindent does not match any outer indentation level', line, here);
          } else if (a !== after.alt) {
            note('inconsistent use of tabs and spaces in indentation', line, here);
          }
        }
        atLineStart = false;
      }
    }

    const ch = text.charAt(pos);
    const nl = newlineLength(pos);
    if (nl > 0) {
      const startCol = col(pos);
      if (brackets.length > 0) {
        push('nl', '\n', line, startCol, line, startCol + nl);
      } else {
        push(lineHasCode ? 'newline' : 'nl', '\n', line, startCol, line, startCol + nl);
        lineHasCode = false;
        atLineStart = true;
      }
      line += 1;
      lineStart = pos + nl;
      pos += nl;
      continue;
    }

    if (ch === ' ' || ch === '\t' || ch === '\f') {
      pos += 1;
      continue;
    }

    if (ch === '\\') {
      const n = newlineLength(pos + 1);
      if (n > 0) {
        line += 1;
        lineStart = pos + 1 + n;
        pos += 1 + n;
        continue;
      }
      note('unexpected character after line continuation character', line, col(pos));
      push('error', ch, line, col(pos), line, col(pos) + 1);
      pos += 1;
      continue;
    }

    if (ch === '#') {
      let end = pos;
      while (end < text.length && newlineLength(end) === 0) end += 1;
      const body = text.slice(pos, end);
      comments.push({ text: body, line, column: col(pos) });
      if (line <= 2 && encoding === undefined) {
        const match = ENCODING.exec(body);
        if (match) encoding = match[1];
      }
      pos = end;
      continue;
    }

    if (ch === '"' || ch === "'") {
      scanString(pos, pos);
      continue;
    }

    const word = identifierAt(text, pos);
    if (word !== undefined) {
      const after = pos + word.length;
      const quoteAfter = text.charAt(after);
      if ((quoteAfter === '"' || quoteAfter === "'") && STRING_PREFIXES.has(word.toLowerCase())) {
        scanString(pos, after);
        continue;
      }
      push(
        HARD_KEYWORDS.has(word) ? 'keyword' : 'name',
        word,
        line,
        col(pos),
        line,
        col(pos) + word.length,
      );
      pos = after;
      continue;
    }

    if (
      (ch >= '0' && ch <= '9') ||
      (ch === '.' && text.charAt(pos + 1) >= '0' && text.charAt(pos + 1) <= '9')
    ) {
      NUMBER.lastIndex = pos;
      const match = NUMBER.exec(text);
      if (match) {
        push('number', match[0], line, col(pos), line, col(pos) + match[0].length);
        pos += match[0].length;
        continue;
      }
    }

    const op = OPERATORS.find((candidate) => text.startsWith(candidate, pos));
    if (op !== undefined) {
      const startCol = col(pos);
      if (op === '(' || op === '[' || op === '{') {
        brackets.push({ char: op, line, column: startCol });
      } else if (op === ')' || op === ']' || op === '}') {
        const open = brackets.pop();
        if (open === undefined) {
          note(`unmatched '${op}'`, line, startCol);
        } else if (CLOSER_OF[op] !== open.char) {
          note(`'${op}' does not match '${open.char}' opened at line ${open.line}`, line, startCol);
        }
      }
      push('op', op, line, startCol, line, startCol + op.length);
      pos += op.length;
      continue;
    }

    note(`invalid character '${ch}'`, line, col(pos));
    push('error', ch, line, col(pos), line, col(pos) + 1);
    pos += 1;
  }

  const endCol = col(pos);
  if (lineHasCode) push('newline', '', line, endCol, line, endCol);
  for (const open of brackets) {
    note(`unclosed '${open.char}'`, open.line, open.column);
  }
  while (indents.length > 1) {
    indents.pop();
    push('dedent', '', line, endCol, line, endCol);
  }
  push('endmarker', '', line, endCol, line, endCol);

  return { tokens, comments, encoding, errors };
}
