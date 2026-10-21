import { describe, expect, it } from 'vitest';
import { tokenize, type TokenKind } from './tokenizer.js';

const pairs = (source: string): [TokenKind, string][] =>
  tokenize(source)
    .tokens.filter((t) => t.kind !== 'nl')
    .map((t): [TokenKind, string] => [t.kind, t.value]);

describe('python tokenizer: positions and tokens', () => {
  it('emits 1-based positions for a simple assignment', () => {
    const { tokens } = tokenize('x = 1\n');
    expect(tokens[0]).toMatchObject({ kind: 'name', value: 'x', line: 1, column: 1, endColumn: 2 });
    expect(tokens[2]).toMatchObject({ kind: 'number', value: '1', line: 1, column: 5 });
    expect(tokens.at(-1)?.kind).toBe('endmarker');
  });

  it('separates hard keywords from soft keywords', () => {
    expect(pairs('match = case\n').slice(0, 3)).toEqual([
      ['name', 'match'],
      ['op', '='],
      ['name', 'case'],
    ]);
    expect(pairs('def f(): pass\n')[0]).toEqual(['keyword', 'def']);
  });

  it('keeps Unicode identifiers whole', () => {
    expect(pairs('café = 1\n')[0]).toEqual(['name', 'café']);
  });

  it('recognises number forms, including underscores and imaginary literals', () => {
    const numbers = tokenize('0x_1F 1_000 1.5e-3 3j .5').tokens.filter((t) => t.kind === 'number');
    expect(numbers.map((t) => t.value)).toEqual(['0x_1F', '1_000', '1.5e-3', '3j', '.5']);
  });

  it('recognises non-f string prefixes as single string tokens', () => {
    const strings = tokenize('rb"x" u"z" Br\'q\'').tokens.filter((t) => t.kind === 'string');
    expect(strings.map((t) => t.value)).toEqual(['rb"x"', 'u"z"', "Br'q'"]);
  });

  it('spans a triple-quoted string across lines', () => {
    const string = tokenize('x = """a\nb"""\n').tokens.find((t) => t.kind === 'string');
    expect(string).toMatchObject({ line: 1, column: 5, endLine: 2, endColumn: 5 });
  });
});

describe('python tokenizer: layout', () => {
  it('emits indent and dedent around a block', () => {
    expect(pairs('def f():\n    return 1\nx\n').map(([k]) => k)).toEqual([
      'keyword',
      'name',
      'op',
      'op',
      'op',
      'newline',
      'indent',
      'keyword',
      'number',
      'newline',
      'dedent',
      'name',
      'newline',
      'endmarker',
    ]);
  });

  it('ignores blank and comment-only lines for indentation', () => {
    const { tokens, comments } = tokenize('if a:\n    b\n\n# c\n    c\n');
    expect(tokens.filter((t) => t.kind === 'indent')).toHaveLength(1);
    expect(tokens.filter((t) => t.kind === 'dedent')).toHaveLength(1);
    expect(comments).toEqual([{ text: '# c', line: 4, column: 1 }]);
  });

  it('joins lines inside brackets without newline tokens', () => {
    const newlines = tokenize('x = [\n  1,\n  2,\n]\n').tokens.filter((t) => t.kind === 'newline');
    expect(newlines).toHaveLength(1);
  });

  it('joins lines after a backslash continuation', () => {
    const newlines = tokenize('x = 1 + \\\n  2\n').tokens.filter((t) => t.kind === 'newline');
    expect(newlines).toHaveLength(1);
  });

  it('handles CRLF line endings and a byte-order mark', () => {
    const { tokens, errors } = tokenize('\uFEFFx = 1\r\ny = 2\r\n');
    expect(errors).toEqual([]);
    expect(tokens.find((t) => t.value === 'y')).toMatchObject({ line: 2, column: 1 });
  });
});

describe('python tokenizer: trivia and diagnostics', () => {
  it('reports the encoding declaration as trivia', () => {
    const result = tokenize('# -*- coding: latin-1 -*-\nx = 1\n');
    expect(result.encoding).toBe('latin-1');
    expect(result.comments).toHaveLength(1);
  });

  it('reports an inconsistent dedent without throwing', () => {
    const { errors } = tokenize('if x:\n        a\n    b\n');
    expect(errors.map((e) => e.message)).toContain(
      'unindent does not match any outer indentation level',
    );
  });

  it('reports an unterminated string and still ends with an endmarker', () => {
    const result = tokenize('x = "abc\n');
    expect(result.errors[0]?.message).toBe('unterminated string literal');
    expect(result.tokens.at(-1)?.kind).toBe('endmarker');
  });

  it('reports unclosed brackets at the end of input', () => {
    const { errors } = tokenize('f(1, [2\n');
    expect(errors.map((e) => e.message)).toEqual(["unclosed '('", "unclosed '['"]);
  });

  it('never throws on any prefix of a sample file', () => {
    const sample =
      'class A:\n    def m(self, x):\n        """doc\n        more"""\n        return "x" if x else [1, 2]\n\nprint(A().m(1))\n';
    for (let i = 0; i <= sample.length; i += 1) {
      const { tokens } = tokenize(sample.slice(0, i));
      expect(tokens.at(-1)?.kind).toBe('endmarker');
    }
  });
});

describe('python tokenizer: f-strings (PEP 701)', () => {
  it('emits a replacement field inline between fstring tokens', () => {
    expect(pairs('f"a{x}b"\n').slice(0, 6)).toEqual([
      ['fstring_start', 'f"'],
      ['fstring_middle', 'a'],
      ['op', '{'],
      ['name', 'x'],
      ['op', '}'],
      ['fstring_middle', 'b'],
    ]);
  });

  it('accepts the same quote inside a replacement field', () => {
    expect(pairs('f"{d["a"]}"\n').slice(0, 8)).toEqual([
      ['fstring_start', 'f"'],
      ['op', '{'],
      ['name', 'd'],
      ['op', '['],
      ['string', '"a"'],
      ['op', ']'],
      ['op', '}'],
      ['fstring_end', '"'],
    ]);
  });

  it('nests f-strings inside replacement fields', () => {
    const starts = pairs('f\'{f"{y}"}\'\n').filter(([kind]) => kind === 'fstring_start');
    expect(starts).toEqual([
      ['fstring_start', "f'"],
      ['fstring_start', 'f"'],
    ]);
  });

  it('treats doubled braces as literal text', () => {
    expect(pairs('f"{{x}}"\n').slice(0, 3)).toEqual([
      ['fstring_start', 'f"'],
      ['fstring_middle', '{{x}}'],
      ['fstring_end', '"'],
    ]);
  });

  it('splits conversions and nested format specifications', () => {
    const ops = pairs('f"{x!r:>{w}}"\n')
      .filter(([kind]) => kind === 'op')
      .map(([, value]) => value);
    expect(ops).toEqual(['{', '!', ':', '{', '}', '}']);
  });

  it('reads := inside a replacement field as a format spec colon', () => {
    const ops = pairs('f"{x:=1}"\n')
      .filter(([kind]) => kind === 'op')
      .map(([, value]) => value);
    expect(ops).toEqual(['{', ':', '}']);
  });

  it('allows a replacement field to span lines in a single-quoted f-string', () => {
    const { errors, tokens } = tokenize('f"{\nx\n}"\n');
    expect(errors).toEqual([]);
    expect(tokens.some((t) => t.kind === 'fstring_end')).toBe(true);
  });

  it('keeps positions across a multi-line triple-quoted f-string', () => {
    const { tokens } = tokenize('x = f"""a\n{b}\nc"""\n');
    expect(tokens.find((t) => t.kind === 'fstring_end')).toMatchObject({ line: 3, column: 2 });
  });

  it('treats a named escape as text, not as a replacement field', () => {
    const source = 'f"\\N{DASH}"\n';
    expect(pairs(source).slice(0, 3)).toEqual([
      ['fstring_start', 'f"'],
      ['fstring_middle', '\\N{DASH}'],
      ['fstring_end', '"'],
    ]);
  });

  it('reports an unterminated f-string and still ends with an endmarker', () => {
    const result = tokenize('f"abc\n');
    expect(result.errors.map((e) => e.message)).toEqual(['unterminated f-string literal']);
    expect(result.tokens.at(-1)?.kind).toBe('endmarker');
  });

  it('reports a lone closing brace in an f-string literal', () => {
    const { errors } = tokenize('f"}"\n');
    expect(errors.map((e) => e.message)).toEqual(["single '}' is not allowed in an f-string"]);
  });
});
