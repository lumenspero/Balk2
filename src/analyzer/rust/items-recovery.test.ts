import { describe, expect, it } from 'vitest';
import { parseRustFile, type Item } from './items.js';

const kinds = (items: readonly Item[]): string[] => items.map((i) => i.kind);
const messages = (errors: readonly { message: string }[]): string[] => errors.map((e) => e.message);

describe('rust item recovery: unclosed brace bodies', () => {
  it('ends an unclosed module before a column-1 item, and reports one error', () => {
    const file = parseRustFile('mod a {\nfn f() {}\nuse b;\n');
    expect(kinds(file.items)).toEqual(['mod', 'fn', 'use']);
    expect(file.errors).toEqual([{ message: 'unclosed `{`', line: 1, column: 7 }]);
  });

  it('ends an unclosed function body before a column-1 struct', () => {
    const file = parseRustFile('fn f() {\n    let x = 1;\nstruct S;\n');
    expect(kinds(file.items)).toEqual(['fn', 'struct']);
    const fn = file.items[0];
    expect(fn?.kind === 'fn' && fn.body?.children).toHaveLength(5);
    expect(messages(file.errors)).toEqual(['unclosed `{`']);
  });

  it('keeps an indented item inside an unclosed body', () => {
    const file = parseRustFile('fn f() {\n    fn g() {}\n');
    expect(kinds(file.items)).toEqual(['fn']);
    expect(messages(file.errors)).toEqual(['unclosed `{`']);
  });

  it('recovers at each level of nested unclosed bodies', () => {
    const file = parseRustFile('fn a() {\nfn b() {\nuse c;\n');
    expect(kinds(file.items)).toEqual(['fn', 'fn', 'use']);
    expect(messages(file.errors)).toEqual(['unclosed `{`', 'unclosed `{`']);
    expect(file.errors.map((e) => e.line)).toEqual([1, 2]);
  });

  it('leaves a closed module unchanged', () => {
    const file = parseRustFile('mod a {\nfn f() {}\n}\n');
    expect(file.errors).toEqual([]);
    const [mod] = file.items;
    expect(mod?.kind === 'mod' && kinds(mod.items)).toEqual(['fn']);
  });

  it('recovers at a column-1 attribute', () => {
    const file = parseRustFile('mod a {\n#[test]\nfn f() {}\n');
    expect(kinds(file.items)).toEqual(['mod', 'fn']);
    expect(file.items[1]?.attrs).toMatchObject([{ path: 'test' }]);
    expect(messages(file.errors)).toEqual(['unclosed `{`']);
  });

  it('recovers an unclosed impl body before the next column-1 item', () => {
    const file = parseRustFile('impl Foo {\nfn new() -> Self {\nuse x;\n');
    expect(kinds(file.items)).toEqual(['impl', 'fn', 'use']);
    expect(messages(file.errors)).toEqual(['unclosed `{`', 'unclosed `{`']);
  });
});
