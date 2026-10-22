import { describe, expect, it } from 'vitest';
import { parseRustFile, type Item } from './items.js';

/** The first item, checked to have the expected kind. */
function only<K extends Item['kind']>(source: string, kind: K): Extract<Item, { kind: K }> {
  const item = parseRustFile(source).items[0];
  if (item?.kind !== kind) throw new Error(`expected ${kind}, got ${item?.kind}`);
  return item as Extract<Item, { kind: K }>;
}

describe('rust items: macro_rules', () => {
  it('keeps the rules as a brace-delimited token group', () => {
    const file = parseRustFile('macro_rules! m { ($x:expr) => { $x }; }');
    expect(file.errors).toEqual([]);
    expect(only('macro_rules! m { () => {} }', 'macro_rules')).toMatchObject({
      name: 'm',
      body: { delimiter: '{' },
    });
  });

  it('accepts a parenthesized definition followed by `;`', () => {
    const file = parseRustFile('macro_rules! n ( () => {} );');
    expect(file.errors).toEqual([]);
    expect(file.items).toHaveLength(1);
    expect(file.items[0]).toMatchObject({ kind: 'macro_rules', body: { delimiter: '(' } });
  });

  it('reports a parenthesized definition with no `;`', () => {
    const file = parseRustFile('macro_rules! q () use a;');
    expect(file.errors.map((e) => e.message)).toEqual(['expected `;` after macro definition']);
  });

  it('reports a macro_rules without a name', () => {
    const file = parseRustFile('macro_rules! {}\nuse a;\n');
    expect(file.errors.map((e) => e.message)).toEqual(['expected a macro name']);
    expect(file.items.map((i) => i.kind)).toEqual(['unknown', 'use']);
  });
});

describe('rust items: macro invocations', () => {
  it('reads a brace invocation without `;`', () => {
    const file = parseRustFile('lazy_static! { static ref X: u8 = 1; }');
    expect(file.errors).toEqual([]);
    expect(file.items[0]).toMatchObject({
      kind: 'macro_call',
      path: 'lazy_static',
      delimiter: '{',
    });
  });

  it('reads a path invocation with `;`', () => {
    const file = parseRustFile('foo::bar!(x);\nuse a;\n');
    expect(file.errors).toEqual([]);
    expect(file.items.map((i) => i.kind)).toEqual(['macro_call', 'use']);
    expect(file.items[0]).toMatchObject({ path: 'foo::bar', delimiter: '(' });
  });

  it('reports a parenthesized invocation with no `;`', () => {
    const file = parseRustFile('foo!(x)\nuse a;\n');
    expect(file.errors.map((e) => e.message)).toEqual(['expected `;` after macro invocation']);
  });
});

describe('rust items: extern crate', () => {
  it('reads a crate with and without an alias', () => {
    expect(only('extern crate foo as bar;', 'extern_crate')).toMatchObject({
      name: 'foo',
      alias: 'bar',
    });
    expect(only('extern crate serde;', 'extern_crate')).toMatchObject({
      name: 'serde',
      alias: null,
    });
  });

  it('reads `extern crate self as name`', () => {
    expect(only('extern crate self as me;', 'extern_crate')).toMatchObject({
      name: 'self',
      alias: 'me',
    });
  });

  it('reports a missing crate name and keeps the next item', () => {
    const file = parseRustFile('extern crate ;\nuse a;\n');
    expect(file.errors.map((e) => e.message)).toEqual(['expected a crate name']);
    expect(file.items.map((i) => i.kind)).toEqual(['unknown', 'use']);
  });
});

describe('rust items: extern blocks', () => {
  it('reads foreign functions and statics with an ABI', () => {
    const block = only(
      'extern "C" { fn puts(s: *const u8) -> i32; static mut errno: i32; }',
      'extern_block',
    );
    expect(block.abi).toBe('"C"');
    expect(block.items.map((i) => i.kind)).toEqual(['fn', 'static']);
    expect(block.items[0]).toMatchObject({ kind: 'fn', name: 'puts', body: null });
  });

  it('reads an extern block without an ABI', () => {
    expect(only('extern { fn f(); }', 'extern_block')).toMatchObject({
      abi: null,
      items: [{ kind: 'fn', name: 'f' }],
    });
  });

  it('reads an unsafe extern block', () => {
    expect(only('unsafe extern "C" { fn h(); }', 'extern_block')).toMatchObject({
      abi: '"C"',
      items: [{ kind: 'fn', name: 'h' }],
    });
  });

  it('reads an extern function with an ABI as a function', () => {
    expect(only('extern "C" fn cb() {}', 'fn').qualifiers).toMatchObject({
      extern: true,
      abi: '"C"',
    });
  });
});
