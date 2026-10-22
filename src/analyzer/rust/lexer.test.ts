import { describe, expect, it } from 'vitest';
import { isKeyword, lexRust, type RustToken, type RustTokenKind } from './lexer.js';

const pairs = (source: string): [RustTokenKind, string][] =>
  lexRust(source)
    .tokens.filter((t) => t.kind !== 'endmarker')
    .map((t): [RustTokenKind, string] => [t.kind, t.text]);

const only = (source: string): RustToken => {
  const tokens = lexRust(source).tokens.filter((t) => t.kind !== 'endmarker');
  if (tokens.length !== 1) throw new Error(`expected one token, got ${tokens.length}`);
  const [token] = tokens;
  if (!token) throw new Error('unreachable');
  return token;
};

describe('rust lexer: positions', () => {
  it('emits 1-based positions with an exclusive end column', () => {
    const { tokens } = lexRust('fn main() {\n    let x = 1;\n}\n');
    expect(tokens[0]).toMatchObject({ text: 'fn', line: 1, column: 1, endColumn: 3 });
    expect(tokens[2]).toMatchObject({ text: '(', line: 1, column: 8 });
    const letToken = tokens.find((t) => t.text === 'let');
    expect(letToken).toMatchObject({ line: 2, column: 5, endColumn: 8 });
    expect(tokens.at(-1)?.kind).toBe('endmarker');
  });

  it('counts a CRLF file line by line and skips a byte order mark', () => {
    const { tokens } = lexRust('﻿fn a() {\r\n    b\r\n}\r\n');
    expect(tokens[0]).toMatchObject({ text: 'fn', line: 1, column: 1 });
    expect(tokens.find((t) => t.text === 'b')).toMatchObject({ line: 2, column: 5 });
  });

  it('places a token after a multi-line string on the right line', () => {
    const { tokens } = lexRust('"a\nb" x');
    expect(tokens[1]).toMatchObject({ text: 'x', line: 2, column: 4 });
  });

  it('returns only an endmarker for empty input', () => {
    const { tokens, errors } = lexRust('');
    expect(tokens.map((t) => t.kind)).toEqual(['endmarker']);
    expect(errors).toEqual([]);
  });
});

describe('rust lexer: identifiers and keywords', () => {
  it('marks keywords without treating them as identifiers', () => {
    const [fn, name] = lexRust('fn main').tokens;
    expect(fn && isKeyword(fn)).toBe(true);
    expect(name && isKeyword(name)).toBe(false);
  });

  it('reads a raw identifier as its name, and never as a keyword', () => {
    const token = only('r#type');
    expect(token).toMatchObject({ kind: 'ident', raw: true, value: 'type', text: 'r#type' });
    expect(isKeyword(token)).toBe(false);
  });

  it('keeps Unicode identifiers whole', () => {
    const names = lexRust('café 変数 _x').tokens.map((t) => t.value);
    expect(names).toEqual(['café', '変数', '_x', '']);
  });

  it('lexes a lone underscore as an identifier', () => {
    expect(only('_')).toMatchObject({ kind: 'ident', value: '_' });
  });
});

describe('rust lexer: lifetimes and char literals', () => {
  it('tells a lifetime from a char literal', () => {
    expect(pairs("'a 'static 'a' '1'")).toEqual([
      ['lifetime', "'a"],
      ['lifetime', "'static"],
      ['char', "'a'"],
      ['char', "'1'"],
    ]);
  });

  it('reads escaped and non-ASCII char literals', () => {
    expect(pairs(String.raw`'\n' '\'' '\x7f' '\u{1F600}' '😀' 'é'`)).toEqual([
      ['char', String.raw`'\n'`],
      ['char', String.raw`'\''`],
      ['char', String.raw`'\x7f'`],
      ['char', String.raw`'\u{1F600}'`],
      ['char', "'😀'"],
      ['char', "'é'"],
    ]);
  });
});

describe('rust lexer: numbers', () => {
  it('reads radix literals and suffixes', () => {
    expect(pairs('0xFF_u8 0o17 0b1010 1_000 1usize')).toEqual([
      ['int', '0xFF_u8'],
      ['int', '0o17'],
      ['int', '0b1010'],
      ['int', '1_000'],
      ['int', '1usize'],
    ]);
  });

  it('reads floats, exponents and f32/f64 suffixes', () => {
    expect(pairs('1.5e-3 2. 1e10 1f32 3.0_f64')).toEqual([
      ['float', '1.5e-3'],
      ['float', '2.'],
      ['float', '1e10'],
      ['float', '1f32'],
      ['float', '3.0_f64'],
    ]);
  });

  it('does not read a range or a method call as a float', () => {
    expect(pairs('1..2')).toEqual([
      ['int', '1'],
      ['punct', '..'],
      ['int', '2'],
    ]);
    expect(pairs('1.foo')).toEqual([
      ['int', '1'],
      ['punct', '.'],
      ['ident', 'foo'],
    ]);
  });

  it('does not treat hex digits as an f32 suffix', () => {
    expect(pairs('0x1f32')).toEqual([['int', '0x1f32']]);
  });
});

describe('rust lexer: strings and prefixes', () => {
  it('reads ordinary strings with escapes', () => {
    expect(pairs(String.raw`"a\"b" "c\\"`)).toEqual([
      ['str', String.raw`"a\"b"`],
      ['str', String.raw`"c\\"`],
    ]);
  });

  it('reads raw strings with any number of hashes', () => {
    const tokens = lexRust(String.raw`r"x\n" r#"a"b"# r##"#"##`).tokens;
    expect(tokens.map((t) => [t.kind, t.raw, t.text])).toEqual([
      ['str', true, String.raw`r"x\n"`],
      ['str', true, String.raw`r#"a"b"#`],
      ['str', true, String.raw`r##"#"##`],
      ['endmarker', false, ''],
    ]);
  });

  it('reads byte, byte string, C string and raw variants', () => {
    expect(pairs(`b'a' b"x" br"x" c"x" cr#"x"#`)).toEqual([
      ['byte', "b'a'"],
      ['byte_str', 'b"x"'],
      ['byte_str', 'br"x"'],
      ['c_str', 'c"x"'],
      ['c_str', 'cr#"x"#'],
    ]);
  });

  it('keeps a multi-line string as one token', () => {
    const tokens = lexRust('"one\ntwo"').tokens;
    expect(tokens[0]).toMatchObject({ kind: 'str', line: 1, endLine: 2, endColumn: 5 });
  });

  it('keeps prefix letters as identifiers when no quote follows', () => {
    expect(pairs('br cr r b')).toEqual([
      ['ident', 'br'],
      ['ident', 'cr'],
      ['ident', 'r'],
      ['ident', 'b'],
    ]);
  });
});

describe('rust lexer: comments and trivia', () => {
  it('keeps comments out of the token stream and classifies doc comments', () => {
    const { tokens, trivia } = lexRust(
      '// plain\n/// outer\n//! inner\n//// not doc\n/** outer block */\n/*! inner block */\n/**/ x',
    );
    expect(tokens.map((t) => t.text)).toEqual(['x', '']);
    expect(trivia.map((t) => [t.kind, t.inner])).toEqual([
      ['comment', false],
      ['doc', false],
      ['doc', true],
      ['comment', false],
      ['doc', false],
      ['doc', true],
      ['comment', false],
    ]);
  });

  it('nests block comments', () => {
    const { tokens, trivia, errors } = lexRust('/* a /* b */ still */ x');
    expect(tokens[0]?.text).toBe('x');
    expect(trivia).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it('reads a shebang line as trivia', () => {
    const { tokens, trivia } = lexRust('#!/usr/bin/env run\nfn f() {}');
    expect(trivia[0]).toMatchObject({ kind: 'shebang', line: 1 });
    expect(tokens[0]).toMatchObject({ kind: 'ident', text: 'fn' });
  });

  it('does not treat an inner attribute as a shebang', () => {
    const { tokens, trivia } = lexRust('#![allow(dead_code)]\n');
    expect(trivia).toEqual([]);
    expect(tokens[0]).toMatchObject({ kind: 'punct', text: '#' });
    expect(tokens[1]).toMatchObject({ kind: 'punct', text: '!' });
  });
});

describe('rust lexer: punctuation', () => {
  it('returns the longest punctuation form', () => {
    expect(
      pairs('a >>= b ..= c :: d -> e => f ... g')
        .filter(([kind]) => kind === 'punct')
        .map(([, text]) => text),
    ).toEqual(['>>=', '..=', '::', '->', '=>', '...']);
  });

  it('keeps a shift or comparison as one token for the parser to split', () => {
    expect(pairs('>>').map(([, text]) => text)).toEqual(['>>']);
    expect(pairs('>=').map(([, text]) => text)).toEqual(['>=']);
  });
});

describe('rust lexer: malformed input', () => {
  it('reports an unterminated string and still ends with an endmarker', () => {
    const { tokens, errors } = lexRust('let s = "abc');
    expect(tokens.map((t) => t.kind)).toEqual(['ident', 'ident', 'punct', 'error', 'endmarker']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 1, column: 9 });
  });

  it('reports an unterminated block comment', () => {
    const { trivia, errors } = lexRust('/* open');
    expect(trivia).toHaveLength(1);
    expect(errors.map((e) => e.message)).toEqual(['unterminated block comment']);
  });

  it('reports an unterminated raw string', () => {
    const { tokens, errors } = lexRust('r#"open');
    expect(tokens[0]).toMatchObject({ kind: 'error', raw: true });
    expect(errors).toHaveLength(1);
  });

  it('reports an unexpected character and keeps lexing', () => {
    const { tokens, errors } = lexRust('a ` b');
    expect(tokens.map((t) => t.kind)).toEqual(['ident', 'error', 'ident', 'endmarker']);
    expect(errors).toHaveLength(1);
  });

  it('reports an empty char literal', () => {
    const { errors } = lexRust("''");
    expect(errors.length).toBeGreaterThan(0);
  });
});
