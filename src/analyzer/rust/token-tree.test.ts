import { describe, expect, it } from 'vitest';
import { lexRust } from './lexer.js';
import {
  buildTokenTrees,
  isTokenGroup,
  type TokenTree,
  type TokenTreeResult,
} from './token-tree.js';
import { rustSyntaxNotes } from './syntax-notes.js';

const build = (source: string): TokenTreeResult => buildTokenTrees(lexRust(source).tokens);

/** Tokens by text. Groups as their opener, their children, and their closer (`?` when unclosed). */
const shape = (trees: readonly TokenTree[]): string =>
  trees
    .map((tree) =>
      isTokenGroup(tree)
        ? `${tree.open.text}${shape(tree.children)}${tree.close?.text ?? '?'}`
        : tree.text,
    )
    .join(' ');

describe('rust token trees: nesting', () => {
  it('groups balanced delimiters and keeps siblings in order', () => {
    const { trees, errors } = build('f(a, [b, {c}]) d');
    expect(errors).toEqual([]);
    expect(shape(trees)).toBe('f (a , [b , {c}]) d');
  });

  it('builds empty groups', () => {
    const { trees, errors } = build('() {} []');
    expect(errors).toEqual([]);
    expect(trees.every(isTokenGroup)).toBe(true);
    expect(shape(trees)).toBe('() {} []');
  });

  it('handles deep nesting', () => {
    const { trees, errors } = build(`${'{'.repeat(200)}x${'}'.repeat(200)}`);
    expect(errors).toEqual([]);
    expect(trees).toHaveLength(1);
  });

  it('keeps delimiters inside strings and comments out of the trees', () => {
    const { trees, errors } = build('"(" /* { */ x // )\n');
    expect(errors).toEqual([]);
    expect(shape(trees)).toBe('"(" x');
  });

  it('keeps delimiters inside raw strings out of the trees', () => {
    const { trees, errors } = build('r#"}"# x');
    expect(errors).toEqual([]);
    expect(shape(trees)).toBe('r#"}"# x');
  });
});

describe('rust token trees: positions', () => {
  it('spans a group from its opener to its closer', () => {
    const { trees } = build('fn f() {\n    x\n}\n');
    const block = trees.filter(isTokenGroup).at(-1);
    expect(block).toMatchObject({
      delimiter: '{',
      line: 1,
      column: 8,
      endLine: 3,
      endColumn: 2,
    });
    expect(block?.close).toMatchObject({ text: '}', line: 3, column: 1 });
  });
});

describe('rust token trees: recovery', () => {
  it('keeps a stray closer as a token and reports it', () => {
    const { trees, errors } = build('a ) b');
    expect(shape(trees)).toBe('a ) b');
    expect(errors).toEqual([{ message: 'unmatched `)`', line: 1, column: 3 }]);
  });

  it('closes inner groups when an outer closer arrives, and reports each one', () => {
    const { trees, errors } = build('f( [ x )');
    expect(shape(trees)).toBe('f ([x?)');
    expect(errors).toEqual([{ message: 'unclosed `[`', line: 1, column: 4 }]);
    const outer = trees.find(isTokenGroup);
    expect(outer?.close?.text).toBe(')');
  });

  it('leaves a group unclosed at end of input, and reports it at its opener', () => {
    const { trees, errors } = build('fn f() {\n    let x = 1;\n');
    const block = trees.filter(isTokenGroup).at(-1);
    expect(block?.close).toBeNull();
    expect(errors).toEqual([{ message: 'unclosed `{`', line: 1, column: 8 }]);
  });

  it('reports every unclosed opener at end of input, in source order', () => {
    const { errors } = build('( [ {');
    expect(errors.map((e) => e.message)).toEqual(['unclosed `(`', 'unclosed `[`', 'unclosed `{`']);
  });

  it('treats a mismatched closer with no opener as stray, and keeps the open group', () => {
    const { trees, errors } = build('( ] x');
    expect(errors.map((e) => e.message)).toEqual(['unmatched `]`', 'unclosed `(`']);
    expect(shape(trees)).toBe('(] x?');
  });

  it('keeps lexer error tokens as leaves without adding tree errors', () => {
    const { trees, errors } = build('f(` )');
    expect(shape(trees)).toBe('f (`)');
    expect(errors).toEqual([]);
  });

  it('never throws on arbitrary closers and openers', () => {
    const { trees } = build(')]}({[)]}');
    expect(trees.length).toBeGreaterThan(0);
  });
});

describe('rust syntax notes', () => {
  it('maps lexer and tree problems to syntax notes with the file path, in source order', () => {
    const notes = rustSyntaxNotes('src/lib.rs', 'fn f() {\n  let s = "abc\n');
    expect(notes).toEqual([
      { path: 'src/lib.rs', line: 1, column: 8, message: 'unclosed `{`' },
      { path: 'src/lib.rs', line: 2, column: 11, message: 'unterminated string literal' },
    ]);
  });

  it('reports nothing for a well-formed file', () => {
    expect(rustSyntaxNotes('a.rs', 'fn f(x: [u8; 2]) -> u8 { x[0] }\n')).toEqual([]);
  });
});
