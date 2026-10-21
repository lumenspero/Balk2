/**
 * Python tokenizer (V3 Phase 3.1).
 *
 * Positions are 1-based, the same convention as SourceSpan. Columns count
 * UTF-16 code units, as the TypeScript front end does. Comments and the
 * encoding declaration are trivia: they are returned beside the token stream,
 * never inside it. Tokenizing never throws; malformed input produces notes.
 *
 * f-strings follow PEP 701. Their literal parts are emitted as fstring_start,
 * fstring_middle and fstring_end tokens, and their replacement fields are
 * tokenized in the main stream, so nested quotes, nested f-strings and
 * multi-line expressions all produce ordinary tokens.
 */

export type TokenKind =
  | 'name'
  | 'keyword'
  | 'number'
  | 'string'
  | 'fstring_start'
  | 'fstring_middle'
  | 'fstring_end'
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

/** An open f-string literal part, or an open replacement field inside one. */
interface StringFrame {
  readonly kind: 'string';
  readonly quote: string;
  readonly triple: boolean;
  readonly raw: boolean;
  readonly line: number;
  readonly column: number;
}

interface FieldFrame {
  readonly kind: 'field';
  /** Bracket depth at which the field opened. The field closes at this depth. */
  readonly base: number;
  /** True once a top-level `:` has started the format specification. */
  spec: boolean;
  readonly line: number;
  readonly column: number;
}

type Frame = StringFrame | FieldFrame;

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
  const frames: Frame[] = [];
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

  /** True inside brackets or an f-string, where a line break does not end the logical line. */
  const joining = (): boolean => brackets.length > 0 || frames.length > 0;

  /** A plain (non-f) string literal, scanned whole. */
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

  /** Opens an f-string: emits its prefix and quote, then the literal part is scanned in the main loop. */
  const startFString = (start: number, quotePos: number, raw: boolean): void => {
    const quote = text.charAt(quotePos);
    const triple = text.startsWith(quote.repeat(3), quotePos);
    const end = quotePos + (triple ? 3 : 1);
    push('fstring_start', text.slice(start, end), line, col(start), line, col(end));
    pos = end;
    frames.push({ kind: 'string', quote, triple, raw, line, column: col(start) });
  };

  /** Scans the literal part of an f-string up to its closing quote, a replacement field, or a line break. */
  const scanFStringLiteral = (frame: StringFrame): void => {
    const delim = frame.triple ? frame.quote.repeat(3) : frame.quote;
    const startLine = line;
    const startCol = col(pos);
    let p = pos;
    while (p < text.length) {
      const c = text.charAt(p);
      if (c === '\\') {
        if (!frame.raw && text.startsWith('\\N{', p)) {
          const close = text.indexOf('}', p + 3);
          p = close === -1 ? text.length : close + 1;
          continue;
        }
        const next = text.charAt(p + 1);
        if (next === '{' || next === '}') {
          p += 1;
          continue;
        }
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
      if (c === frame.quote && text.startsWith(delim, p)) break;
      if (c === '{' || c === '}') {
        if (text.charAt(p + 1) === c) {
          p += 2;
          continue;
        }
        break;
      }
      const n = newlineLength(p);
      if (n > 0) {
        if (!frame.triple) break;
        line += 1;
        lineStart = p + n;
        p += n;
        continue;
      }
      p += 1;
    }
    if (p > pos) push('fstring_middle', text.slice(pos, p), startLine, startCol, line, col(p));
    pos = p;
    if (p >= text.length) return;

    const c = text.charAt(p);
    if (c === frame.quote && text.startsWith(delim, p)) {
      push('fstring_end', delim, line, col(p), line, col(p) + delim.length);
      pos = p + delim.length;
      frames.pop();
      return;
    }
    if (c === '{') {
      push('op', '{', line, col(p), line, col(p) + 1);
      pos = p + 1;
      frames.push({ kind: 'field', base: brackets.length, spec: false, line, column: col(p) });
      return;
    }
    if (c === '}') {
      note("single '}' is not allowed in an f-string", line, col(p));
      push('error', '}', line, col(p), line, col(p) + 1);
      pos = p + 1;
      return;
    }
    // Only a line break is left: a single-quoted literal that never closed.
    note('unterminated f-string literal', frame.line, frame.column);
    frames.pop();
  };

  /** Scans the format specification after a top-level `:` in a replacement field. */
  const scanFormatSpec = (): void => {
    const startLine = line;
    const startCol = col(pos);
    let p = pos;
    while (p < text.length) {
      const c = text.charAt(p);
      if (c === '{' || c === '}') break;
      const n = newlineLength(p);
      if (n > 0) {
        line += 1;
        lineStart = p + n;
        p += n;
        continue;
      }
      p += 1;
    }
    if (p > pos) push('fstring_middle', text.slice(pos, p), startLine, startCol, line, col(p));
    pos = p;
    if (p >= text.length) return;

    if (text.charAt(p) === '{') {
      push('op', '{', line, col(p), line, col(p) + 1);
      pos = p + 1;
      frames.push({ kind: 'field', base: brackets.length, spec: false, line, column: col(p) });
      return;
    }
    // A closing brace ends the field whose format specification this is.
    push('op', '}', line, col(p), line, col(p) + 1);
    pos = p + 1;
    frames.pop();
  };

  while (pos < text.length) {
    const frame = frames[frames.length - 1];
    if (frame?.kind === 'string') {
      scanFStringLiteral(frame);
      continue;
    }
    if (frame?.kind === 'field' && frame.spec) {
      scanFormatSpec();
      continue;
    }

    if (atLineStart && !joining()) {
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
        const current = currentIndent(indents);
        const here = col(p);
        if (c > current.col) {
          if (a <= current.alt) {
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
      if (joining()) {
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
      const prefix = word.toLowerCase();
      if ((quoteAfter === '"' || quoteAfter === "'") && STRING_PREFIXES.has(prefix)) {
        if (prefix.includes('f') || prefix.includes('t')) {
          startFString(pos, after, prefix.includes('r'));
        } else {
          scanString(pos, after);
        }
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

    // Replacement-field punctuation, checked before the general operators.
    if (frame?.kind === 'field' && brackets.length === frame.base) {
      if (ch === '}') {
        push('op', '}', line, col(pos), line, col(pos) + 1);
        pos += 1;
        frames.pop();
        continue;
      }
      if (ch === ':') {
        frame.spec = true;
        push('op', ':', line, col(pos), line, col(pos) + 1);
        pos += 1;
        continue;
      }
      if (ch === '!' && text.charAt(pos + 1) !== '=') {
        push('op', '!', line, col(pos), line, col(pos) + 1);
        pos += 1;
        continue;
      }
    }

    const op = OPERATORS.find((candidate) => text.startsWith(candidate, pos));
    if (op !== undefined) {
      const startCol = col(pos);
      if (op === '(' || op === '[' || op === '{') {
        brackets.push({ char: op, line, column: startCol });
      } else if (op === ')' || op === ']' || op === '}') {
        const floor = frame?.kind === 'field' ? frame.base : 0;
        const opener = brackets.length > floor ? brackets.pop() : undefined;
        if (opener === undefined) {
          note(`unmatched '${op}'`, line, startCol);
        } else if (CLOSER_OF[op] !== opener.char) {
          note(
            `'${op}' does not match '${opener.char}' opened at line ${opener.line}`,
            line,
            startCol,
          );
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
  for (const opener of brackets) {
    note(`unclosed '${opener.char}'`, opener.line, opener.column);
  }
  for (const open of frames.splice(0)) {
    note(
      open.kind === 'string' ? 'unterminated f-string literal' : 'unclosed replacement field',
      open.line,
      open.column,
    );
  }
  while (indents.length > 1) {
    indents.pop();
    push('dedent', '', line, endCol, line, endCol);
  }
  push('endmarker', '', line, endCol, line, endCol);

  return { tokens, comments, encoding, errors };
}
