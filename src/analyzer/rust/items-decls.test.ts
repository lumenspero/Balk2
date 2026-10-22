import { describe, expect, it } from 'vitest';
import { parseRustFile, type Item } from './items.js';

/** The first item, checked to have the expected kind. */
function only<K extends Item['kind']>(source: string, kind: K): Extract<Item, { kind: K }> {
  const item = parseRustFile(source).items[0];
  if (item?.kind !== kind) throw new Error(`expected ${kind}, got ${item?.kind}`);
  return item as Extract<Item, { kind: K }>;
}

describe('rust items: functions', () => {
  it('reads qualifiers, generics, parameters, return type and where clause', () => {
    const fn = only(
      'pub const unsafe extern "C" fn add<T: Copy, const N: usize>(&self, a: u8) -> Result<u8, E> where T: Clone { }',
      'fn',
    );
    expect(fn.name).toBe('add');
    expect(fn.qualifiers).toEqual({
      const: true,
      async: false,
      unsafe: true,
      extern: true,
      abi: '"C"',
    });
    expect(fn.generics).toEqual([
      { kind: 'type', name: 'T', raw: 'T : Copy' },
      { kind: 'const', name: 'N', raw: 'const N : usize' },
    ]);
    expect(fn.params).toMatchObject([
      { kind: 'self', raw: '& self', type: null },
      { kind: 'typed', pattern: 'a', type: { raw: 'u8' } },
    ]);
    expect(fn.ret?.raw).toBe('Result < u8 , E >');
    expect(fn.where).toBe('T : Clone');
    expect(fn.body).not.toBeNull();
  });

  it('reads a declaration with no body', () => {
    const fn = only('fn f(x: u8);', 'fn');
    expect(fn.body).toBeNull();
    expect(fn.ret).toBeNull();
    expect(fn.params).toHaveLength(1);
  });

  it('reads a lifetime self parameter and a typed self parameter', () => {
    const fn = only("fn f(&'a mut self, other: Self) {}", 'fn');
    expect(fn.params[0]).toMatchObject({ kind: 'self', raw: "& 'a mut self" });
    const typed = only('fn g(self: Box<Self>) {}', 'fn');
    expect(typed.params[0]).toMatchObject({ kind: 'self', type: { raw: 'Box < Self >' } });
  });

  it('reads const, async and unsafe qualifiers without the fn keyword being an item', () => {
    expect(only('const fn f() {}', 'fn').qualifiers.const).toBe(true);
    expect(only('async unsafe fn g() {}', 'fn').qualifiers).toMatchObject({
      async: true,
      unsafe: true,
    });
  });

  it('reports a function without a parenthesized parameter list', () => {
    const file = parseRustFile('fn f {}\nuse a;\n');
    expect(file.errors.map((e) => e.message)).toContain('expected `(` after function name');
    expect(file.items.map((i) => i.kind)).toEqual(['unknown', 'use']);
  });
});

describe('rust items: structs, enums and unions', () => {
  it('reads named fields with visibility, attributes and lifetimes', () => {
    const struct = only("pub struct P<'a, T> { pub x: u8, #[cfg(x)] y: Vec<u8>, }", 'struct');
    expect(struct).toMatchObject({ name: 'P', shape: 'named' });
    expect(struct.generics.map((g) => [g.kind, g.name])).toEqual([
      ['lifetime', "'a"],
      ['type', 'T'],
    ]);
    expect(struct.fields.map((f) => f.name)).toEqual(['x', 'y']);
    expect(struct.fields[0]?.vis).toEqual({ kind: 'public' });
    expect(struct.fields[1]?.attrs).toMatchObject([{ path: 'cfg' }]);
    expect(struct.fields[1]?.type.raw).toBe('Vec < u8 >');
  });

  it('reads tuple structs with a where clause after the fields', () => {
    const struct = only('struct T(pub u8, String) where u8: Copy;', 'struct');
    expect(struct).toMatchObject({ shape: 'tuple', where: 'u8 : Copy' });
    expect(struct.fields.map((f) => f.name)).toEqual([null, null]);
  });

  it('reads a unit struct', () => {
    expect(only('struct U;', 'struct')).toMatchObject({ shape: 'unit', fields: [] });
  });

  it('reads enum variants of each shape and a discriminant', () => {
    const e = only('enum E { A, B(u8), C { x: u8 }, D = 4, }', 'enum');
    expect(e.variants.map((v) => [v.name, v.shape])).toEqual([
      ['A', 'unit'],
      ['B', 'tuple'],
      ['C', 'struct'],
      ['D', 'unit'],
    ]);
    expect(e.variants[1]?.fields).toHaveLength(1);
    expect(e.variants[3]?.discriminant?.raw).toBe('4');
  });

  it('reads a union with named fields', () => {
    const u = only('union U { a: u32, b: f32 }', 'union');
    expect(u.fields.map((f) => f.name)).toEqual(['a', 'b']);
  });

  it('treats union as an identifier unless it starts a union declaration', () => {
    const file = parseRustFile('union = 5;\n');
    expect(file.errors).toEqual([]);
    expect(file.items.map((i) => i.kind)).toEqual(['unknown']);
  });

  it('reports a struct without a name and keeps going', () => {
    const file = parseRustFile('struct;\nuse a;\n');
    expect(file.errors.map((e) => e.message)).toEqual(['expected a struct name']);
    expect(file.items.map((i) => i.kind)).toEqual(['unknown', 'use']);
  });
});

describe('rust items: type aliases, constants and statics', () => {
  it('reads a type alias with generics', () => {
    const alias = only('pub type R<T> = Result<T, E>;', 'type');
    expect(alias.name).toBe('R');
    expect(alias.generics.map((g) => g.name)).toEqual(['T']);
    expect(alias.ty?.raw).toBe('Result < T , E >');
  });

  it('reads a constant with its type and value', () => {
    expect(only('const N: usize = 3;', 'const')).toMatchObject({
      name: 'N',
      ty: { raw: 'usize' },
      value: { raw: '3' },
    });
  });

  it('reads a trait-style constant without a value', () => {
    const file = parseRustFile('const X: u8;');
    expect(file.errors).toEqual([]);
    expect(file.items[0]).toMatchObject({ kind: 'const', value: null });
  });

  it('reads a mutable static', () => {
    expect(only('pub static mut COUNTER: u32 = 0;', 'static')).toMatchObject({
      name: 'COUNTER',
      mutable: true,
      ty: { raw: 'u32' },
      value: { raw: '0' },
    });
  });

  it('reports a static without a type and still reads its value', () => {
    const file = parseRustFile('static X = 1;');
    expect(file.errors.map((e) => e.message)).toEqual(['expected `:` after static name']);
    expect(file.items[0]).toMatchObject({ kind: 'static', value: { raw: '1' } });
  });
});
