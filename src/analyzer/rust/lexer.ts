/**
 * Rust lexer (V3 Phase 6.1).
 *
 * Positions are 1-based, the same convention as SourceSpan. Columns count UTF-16
 * code units, as the Python tokenizer does. Comments, doc comments and a shebang
 * line are trivia: they are returned beside the token stream, never inside it.
 *
 * Lexing never throws. Malformed input produces an `error` token and a note. Every
 * step consumes at least one character, so the lexer always terminates.
 *
 * Punctuation is returned in its longest form (`>>=`, `..=`, `::`). The parser
 * splits `>>` or `>=` where generics need it. A tuple index chain such as `t.0.1`
 * lexes as a float, and the parser splits it.
 */

export type RustTokenKind =
  | 'ident'
  | 'lifetime'
  | 'int'
  | 'float'
  | 'char'
  | 'byte'
  | 'str'
  | 'byte_str'
  | 'c_str'
  | 'punct'
  | 'error'
  | 'endmarker';

export interface RustToken {
  readonly kind: RustTokenKind;
  /** The source text as written, including prefixes, quotes, suffixes and `r#`. */
  readonly text: string;
  /** The name of an identifier without `r#`. For every other token, the same as `text`. */
  readonly value: string;
  /** True for raw identifiers (`r#type`) and raw string literals (`r"..."`, `r#"..."#`). */
  readonly raw: boolean;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface RustTrivia {
  readonly kind: 'comment' | 'doc' | 'shebang';
  readonly text: string;
  /** For doc comments: `//!` and `/*!` are inner, `///` and `/**` are outer. */
  readonly inner: boolean;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface RustLexNote {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export interface RustLexResult {
  readonly tokens: readonly RustToken[];
  readonly trivia: readonly RustTrivia[];
  readonly errors: readonly RustLexNote[];
}

/**
 * Strict and reserved keywords for the 2018 and later editions. Weak keywords
 * (`union`, `default`, `auto`, `macro_rules`) are identifiers. Edition 2015 treats
 * `async`, `await`, `dyn` and `try` as identifiers; the parser handles that.
 */
export const RUST_KEYWORDS: ReadonlySet<string> = new Set([
  'abstract',
  'as',
  'async',
  'await',
  'become',
  'box',
  'break',
  'const',
  'continue',
  'crate',
  'do',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'final',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'macro',
  'match',
  'mod',
  'move',
  'mut',
  'override',
  'priv',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'try',
  'type',
  'typeof',
  'unsafe',
  'unsized',
  'use',
  'virtual',
  'where',
  'while',
  'yield',
]);

/** True for a keyword token. A raw identifier (`r#type`) is never a keyword. */
export function isKeyword(token: RustToken): boolean {
  return token.kind === 'ident' && !token.raw && RUST_KEYWORDS.has(token.value);
}

const IDENT_START = /^[\p{XID_Start}_]$/u;
const IDENT_CONTINUE = /^\p{XID_Continue}$/u;

/** Longest first, so the first match is the longest match. */
const PUNCTUATION: readonly string[] = [
  '<<=',
  '>>=',
  '...',
  '..=',
  '::',
  '->',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '^=',
  '&=',
  '|=',
  '<<',
  '>>',
  '..',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '!',
  '&',
  '|',
  '=',
  '<',
  '>',
  '@',
  '.',
  ',',
  ';',
  ':',
  '#',
  '$',
  '?',
  '~',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
];

interface Pos {
  readonly i: number;
  readonly line: number;
  readonly column: number;
}

interface Scanned {
  readonly kind: RustTokenKind;
  readonly raw: boolean;
}

/** Reads source by UTF-16 index and tracks line and column. */
class Cursor {
  i: number;
  line = 1;
  lineStart: number;

  constructor(
    readonly src: string,
    start: number,
  ) {
    this.i = start;
    this.lineStart = start;
  }

  get column(): number {
    return this.i - this.lineStart + 1;
  }

  get eof(): boolean {
    return this.i >= this.src.length;
  }

  /** The code unit `offset` places ahead, or '' past the end. */
  at(offset: number): string {
    return this.src.charAt(this.i + offset);
  }

  pos(): Pos {
    return { i: this.i, line: this.line, column: this.column };
  }

  advance(count: number): void {
    const end = Math.min(this.src.length, this.i + count);
    while (this.i < end) {
      if (this.src.charCodeAt(this.i) === 10) {
        this.line += 1;
        this.lineStart = this.i + 1;
      }
      this.i += 1;
    }
  }
}

/** The whole code point starting at `index`, or '' past the end. */
function codePointAtIndex(src: string, index: number): string {
  const cp = src.codePointAt(index);
  return cp === undefined ? '' : String.fromCodePoint(cp);
}

function isIdentStart(ch: string): boolean {
  return ch !== '' && IDENT_START.test(ch);
}

function isIdentContinue(ch: string): boolean {
  return ch !== '' && IDENT_CONTINUE.test(ch);
}

function scanIdentTail(cur: Cursor): void {
  for (;;) {
    const ch = codePointAtIndex(cur.src, cur.i);
    if (!isIdentContinue(ch)) return;
    cur.advance(ch.length);
  }
}

function consumeWhile(cur: Cursor, pattern: RegExp): void {
  while (pattern.test(cur.at(0))) cur.advance(1);
}

function note(errors: RustLexNote[], start: Pos, message: string): void {
  errors.push({ message, line: start.line, column: start.column });
}

/** Returns `kind` when the literal closed, otherwise notes the error and returns 'error'. */
function finish(
  closed: boolean,
  kind: RustTokenKind,
  errors: RustLexNote[],
  start: Pos,
  message: string,
): RustTokenKind {
  if (closed) return kind;
  note(errors, start, message);
  return 'error';
}

function pushTrivia(
  trivia: RustTrivia[],
  source: string,
  kind: RustTrivia['kind'],
  inner: boolean,
  start: Pos,
  cur: Cursor,
): void {
  trivia.push({
    kind,
    text: source.slice(start.i, cur.i),
    inner,
    line: start.line,
    column: start.column,
    endLine: cur.line,
    endColumn: cur.column,
  });
}

function makeToken(
  source: string,
  kind: RustTokenKind,
  start: Pos,
  cur: Cursor,
  raw: boolean,
): RustToken {
  const text = source.slice(start.i, cur.i);
  return {
    kind,
    text,
    value: kind === 'ident' && raw ? text.slice(2) : text,
    raw,
    line: start.line,
    column: start.column,
    endLine: cur.line,
    endColumn: cur.column,
  };
}

/** A shebang is `#!` unless the next non-whitespace character is `[` (an inner attribute). */
function isInnerAttributeAfter(source: string, from: number): boolean {
  let i = from;
  while (i < source.length && /\s/.test(source.charAt(i))) i += 1;
  return source.charAt(i) === '[';
}

function scanLineComment(cur: Cursor, source: string, trivia: RustTrivia[]): void {
  const start = cur.pos();
  while (!cur.eof && cur.at(0) !== '\n') cur.advance(1);
  const text = source.slice(start.i, cur.i);
  const inner = text.startsWith('//!');
  const outer = /^\/\/\/(?!\/)/.test(text);
  pushTrivia(trivia, source, inner || outer ? 'doc' : 'comment', inner, start, cur);
}

function scanBlockComment(
  cur: Cursor,
  source: string,
  trivia: RustTrivia[],
  errors: RustLexNote[],
): void {
  const start = cur.pos();
  cur.advance(2);
  let depth = 1;
  while (depth > 0 && !cur.eof) {
    if (cur.at(0) === '/' && cur.at(1) === '*') {
      cur.advance(2);
      depth += 1;
    } else if (cur.at(0) === '*' && cur.at(1) === '/') {
      cur.advance(2);
      depth -= 1;
    } else {
      cur.advance(1);
    }
  }
  if (depth > 0) note(errors, start, 'unterminated block comment');
  const text = source.slice(start.i, cur.i);
  const inner = text.startsWith('/*!');
  // `/**/` and `/***` are plain comments, not doc comments.
  const outer = text.startsWith('/**') && text.charAt(3) !== '*' && text.charAt(3) !== '/';
  pushTrivia(trivia, source, inner || outer ? 'doc' : 'comment', inner, start, cur);
}

/** Consumes a numeric suffix such as `u8`, `usize` or `f64`, and returns it. */
function scanSuffix(cur: Cursor): string {
  const from = cur.i;
  const head = codePointAtIndex(cur.src, cur.i);
  if (isIdentStart(head)) {
    cur.advance(head.length);
    scanIdentTail(cur);
  }
  return cur.src.slice(from, cur.i);
}

function scanNumber(cur: Cursor): RustTokenKind {
  const radix = cur.at(0) === '0' ? cur.at(1) : '';
  if (radix === 'x' || radix === 'o' || radix === 'b') {
    cur.advance(2);
    consumeWhile(cur, radix === 'x' ? /[0-9a-fA-F_]/ : /[0-9_]/);
    scanSuffix(cur);
    return 'int';
  }

  consumeWhile(cur, /[0-9_]/);
  let kind: RustTokenKind = 'int';
  // `1.foo` and `1..2` are not floats: a dot before an identifier or another dot is an operator.
  if (
    cur.at(0) === '.' &&
    cur.at(1) !== '.' &&
    !isIdentStart(codePointAtIndex(cur.src, cur.i + 1))
  ) {
    cur.advance(1);
    consumeWhile(cur, /[0-9_]/);
    kind = 'float';
  }
  const signed = cur.at(1) === '+' || cur.at(1) === '-';
  if (/[eE]/.test(cur.at(0)) && /[0-9]/.test(signed ? cur.at(2) : cur.at(1))) {
    cur.advance(signed ? 2 : 1);
    consumeWhile(cur, /[0-9_]/);
    kind = 'float';
  }
  const suffix = scanSuffix(cur);
  return kind === 'int' && /^f(32|64)$/.test(suffix) ? 'float' : kind;
}

/** Body of a quoted string, starting at the opening quote. Returns true when closed. */
function scanQuotedBody(cur: Cursor): boolean {
  cur.advance(1);
  while (!cur.eof) {
    const ch = cur.at(0);
    if (ch === '\\') {
      cur.advance(1);
      cur.advance(codePointAtIndex(cur.src, cur.i).length);
      continue;
    }
    if (ch === '"') {
      cur.advance(1);
      return true;
    }
    cur.advance(1);
  }
  return false;
}

/** The number of `#` in a raw string opener, or -1 when no raw string starts here. */
function rawStringHashes(cur: Cursor, prefixLength: number): number {
  let hashes = 0;
  while (cur.at(prefixLength + hashes) === '#') hashes += 1;
  return cur.at(prefixLength + hashes) === '"' ? hashes : -1;
}

/** Body of a raw string, starting at its prefix. Returns true when closed. */
function scanRawBody(cur: Cursor, prefixLength: number, hashes: number): boolean {
  cur.advance(prefixLength + hashes + 1);
  const close = `"${'#'.repeat(hashes)}`;
  while (!cur.eof) {
    if (cur.src.startsWith(close, cur.i)) {
      cur.advance(close.length);
      return true;
    }
    cur.advance(1);
  }
  return false;
}

/** Body of a char or byte literal, starting at the opening quote. Returns true when closed. */
function scanCharBody(cur: Cursor): boolean {
  cur.advance(1);
  if (cur.at(0) === '\\') {
    cur.advance(1);
    const escaped = codePointAtIndex(cur.src, cur.i);
    if (escaped === '' || escaped === '\n') return false;
    cur.advance(escaped.length);
    // Hex and unicode escapes (`\x7f`, `\u{1F600}`) run to the closing quote. Ten characters
    // covers the longest form, `\u{10FFFF}`.
    for (let n = 0; n < 10 && !cur.eof && cur.at(0) !== "'" && cur.at(0) !== '\n'; n += 1) {
      cur.advance(1);
    }
  } else {
    const ch = codePointAtIndex(cur.src, cur.i);
    if (ch === '' || ch === "'" || ch === '\n') return false;
    cur.advance(ch.length);
  }
  if (cur.at(0) === "'") {
    cur.advance(1);
    return true;
  }
  return false;
}

/** At a `'`: a lifetime (`'a`, `'static`) or a char literal (`'a'`, `'\n'`). */
function scanQuoteToken(cur: Cursor, start: Pos, errors: RustLexNote[]): RustTokenKind {
  const first = codePointAtIndex(cur.src, cur.i + 1);
  if (
    first !== '\\' &&
    isIdentStart(first) &&
    codePointAtIndex(cur.src, cur.i + 1 + first.length) !== "'"
  ) {
    cur.advance(1 + first.length);
    scanIdentTail(cur);
    return 'lifetime';
  }
  return finish(scanCharBody(cur), 'char', errors, start, 'malformed character literal');
}

function scanToken(cur: Cursor, start: Pos, errors: RustLexNote[]): Scanned {
  const src = cur.src;
  const c = cur.at(0);
  const next = cur.at(1);

  // Raw identifier: `r#type`.
  if (c === 'r' && next === '#' && isIdentStart(codePointAtIndex(src, cur.i + 2))) {
    cur.advance(2);
    scanIdentTail(cur);
    return { kind: 'ident', raw: true };
  }

  // Raw strings: `r"..."`, `br"..."`, `cr"..."`, with any number of `#`.
  if (c === 'r' || ((c === 'b' || c === 'c') && next === 'r')) {
    const prefixLength = c === 'r' ? 1 : 2;
    const hashes = rawStringHashes(cur, prefixLength);
    if (hashes >= 0) {
      const kind: RustTokenKind = c === 'r' ? 'str' : c === 'b' ? 'byte_str' : 'c_str';
      const closed = scanRawBody(cur, prefixLength, hashes);
      return { kind: finish(closed, kind, errors, start, 'unterminated raw string'), raw: true };
    }
  }

  if (c === 'b' && next === "'") {
    cur.advance(1);
    const closed = scanCharBody(cur);
    return { kind: finish(closed, 'byte', errors, start, 'malformed byte literal'), raw: false };
  }

  if (c === '"') {
    const closed = scanQuotedBody(cur);
    return {
      kind: finish(closed, 'str', errors, start, 'unterminated string literal'),
      raw: false,
    };
  }

  if ((c === 'b' || c === 'c') && next === '"') {
    cur.advance(1);
    const closed = scanQuotedBody(cur);
    const kind: RustTokenKind = c === 'b' ? 'byte_str' : 'c_str';
    return { kind: finish(closed, kind, errors, start, 'unterminated string literal'), raw: false };
  }

  if (c === "'") return { kind: scanQuoteToken(cur, start, errors), raw: false };

  if (/[0-9]/.test(c)) return { kind: scanNumber(cur), raw: false };

  const head = codePointAtIndex(src, cur.i);
  if (isIdentStart(head)) {
    cur.advance(head.length);
    scanIdentTail(cur);
    return { kind: 'ident', raw: false };
  }

  for (const punct of PUNCTUATION) {
    if (src.startsWith(punct, cur.i)) {
      cur.advance(punct.length);
      return { kind: 'punct', raw: false };
    }
  }

  cur.advance(Math.max(head.length, 1));
  note(errors, start, `unexpected character "${head}"`);
  return { kind: 'error', raw: false };
}

/**
 * Lexes one Rust source file into tokens, trivia and notes.
 *
 * The result always ends with an `endmarker` token. Lexing never throws.
 */
export function lexRust(source: string): RustLexResult {
  const tokens: RustToken[] = [];
  const trivia: RustTrivia[] = [];
  const errors: RustLexNote[] = [];
  // A byte order mark is skipped and does not count as a column.
  const cur = new Cursor(source, source.charCodeAt(0) === 0xfeff ? 1 : 0);

  if (cur.at(0) === '#' && cur.at(1) === '!' && !isInnerAttributeAfter(source, cur.i + 2)) {
    const start = cur.pos();
    while (!cur.eof && cur.at(0) !== '\n') cur.advance(1);
    pushTrivia(trivia, source, 'shebang', false, start, cur);
  }

  while (!cur.eof) {
    const c = cur.at(0);
    if (/\s/.test(c)) {
      cur.advance(1);
      continue;
    }
    if (c === '/' && cur.at(1) === '/') {
      scanLineComment(cur, source, trivia);
      continue;
    }
    if (c === '/' && cur.at(1) === '*') {
      scanBlockComment(cur, source, trivia, errors);
      continue;
    }
    const start = cur.pos();
    const scanned = scanToken(cur, start, errors);
    tokens.push(makeToken(source, scanned.kind, start, cur, scanned.raw));
  }

  const end = cur.pos();
  tokens.push(makeToken(source, 'endmarker', end, cur, false));
  return { tokens, trivia, errors };
}
