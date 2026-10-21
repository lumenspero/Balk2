import type { Span } from './ast.js';
import type { Token, TokenKind } from './tokenizer.js';

/** A syntax error in Python source. Line and column are 1-based. */
export class PythonSyntaxError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = 'PythonSyntaxError';
    this.line = line;
    this.column = column;
  }
}

const END_TOKEN: Token = {
  kind: 'endmarker',
  value: '',
  line: 1,
  column: 1,
  endLine: 1,
  endColumn: 1,
};

/** A cursor over tokens. Blank-line tokens (`nl`) are dropped, since the parser never needs them. */
export class TokenCursor {
  private readonly tokens: readonly Token[];
  private index = 0;
  private lastToken: Token = END_TOKEN;

  constructor(tokens: readonly Token[]) {
    this.tokens = tokens.filter((t) => t.kind !== 'nl');
  }

  /** The current position, for backtracking with `rewind`. */
  position(): number {
    return this.index;
  }

  rewind(position: number): void {
    this.index = position;
  }

  peek(offset = 0): Token {
    const i = Math.min(this.index + offset, this.tokens.length - 1);
    return this.tokens[i] ?? END_TOKEN;
  }

  advance(): Token {
    const token = this.peek();
    this.lastToken = token;
    if (this.index < this.tokens.length - 1) this.index += 1;
    return token;
  }

  is(kind: TokenKind, value?: string, offset = 0): boolean {
    const token = this.peek(offset);
    return token.kind === kind && (value === undefined || token.value === value);
  }

  isOp(value: string, offset = 0): boolean {
    return this.is('op', value, offset);
  }

  isKeyword(value: string, offset = 0): boolean {
    return this.is('keyword', value, offset);
  }

  match(kind: TokenKind, value?: string): Token | undefined {
    return this.is(kind, value) ? this.advance() : undefined;
  }

  expect(kind: TokenKind, value: string | undefined, message: string): Token {
    const token = this.match(kind, value);
    if (token === undefined) this.fail(message);
    return token;
  }

  /** The span from `start` to the last consumed token. */
  spanFrom(start: Token): Span {
    return {
      line: start.line,
      column: start.column,
      endLine: this.lastToken.endLine,
      endColumn: this.lastToken.endColumn,
    };
  }

  fail(message: string, token: Token = this.peek()): never {
    throw new PythonSyntaxError(message, token.line, token.column);
  }
}
