import { describe, expect, it } from 'vitest';
import { parseRustFile, type Item } from './items.js';

/** The first item, checked to have the expected kind. */
function only<K extends Item['kind']>(source: string, kind: K): Extract<Item, { kind: K }> {
  const item = parseRustFile(source).items[0];
  if (item?.kind !== kind) throw new Error(`expected ${kind}, got ${item?.kind}`);
  return item as Extract<Item, { kind: K }>;
}

const kindsOf = (items: readonly Item[]): string[] => items.map((i) => i.kind);

describe('rust items: traits', () => {
  it('reads supertraits, where clause and associated items in order', () => {
    const trait = only(
      'pub trait Shape<T>: Debug + Clone where T: Copy { type Out: Display; const SIDES: u32; fn area(&self) -> f64; fn name(&self) -> &str { "x" } }',
      'trait',
    );
    expect(trait.name).toBe('Shape');
    expect(trait.generics.map((g) => g.name)).toEqual(['T']);
    expect(trait.supertraits?.raw).toBe('Debug + Clone');
    expect(trait.where).toBe('T : Copy');
    expect(kindsOf(trait.items)).toEqual(['type', 'const', 'fn', 'fn']);

    const [assocType, constant, required, provided] = trait.items;
    expect(assocType).toMatchObject({ kind: 'type', bounds: { raw: 'Display' }, ty: null });
    expect(constant).toMatchObject({ kind: 'const', name: 'SIDES', value: null });
    expect(required).toMatchObject({ kind: 'fn', name: 'area', body: null });
    expect(provided).toMatchObject({ kind: 'fn', name: 'name' });
    expect(provided?.kind === 'fn' && provided.body).not.toBeNull();
  });

  it('reads unsafe and auto traits', () => {
    expect(only('unsafe trait U {}', 'trait')).toMatchObject({ unsafe: true, auto: false });
    expect(only('auto trait A {}', 'trait')).toMatchObject({ unsafe: false, auto: true });
  });

  it('reads a trait without generics, with one supertrait', () => {
    expect(only('trait A: B {}', 'trait')).toMatchObject({
      supertraits: { raw: 'B' },
      items: [],
    });
  });

  it('reads attributes on trait items', () => {
    const trait = only('trait T { #[inline] fn f(&self) {} }', 'trait');
    expect(trait.items[0]?.attrs).toMatchObject([{ path: 'inline' }]);
  });
});

describe('rust items: impls', () => {
  it('reads a trait impl with its generics, trait path, self type and where clause', () => {
    const imp = only(
      'impl<T: Copy> fmt::Display for Wrapper<T> where T: Debug { type Out = u8; fn fmt(&self, f: &mut Formatter) -> Result { Ok(()) } }',
      'impl',
    );
    expect(imp.generics.map((g) => g.name)).toEqual(['T']);
    expect(imp.negative).toBe(false);
    expect(imp.trait?.raw).toBe('fmt :: Display');
    expect(imp.selfTy.raw).toBe('Wrapper < T >');
    expect(imp.where).toBe('T : Debug');
    expect(kindsOf(imp.items)).toEqual(['type', 'fn']);
    expect(imp.items[0]).toMatchObject({ kind: 'type', ty: { raw: 'u8' } });
  });

  it('reads an inherent impl with no trait', () => {
    const imp = only('impl Foo { fn new() -> Self { Foo } }', 'impl');
    expect(imp.trait).toBeNull();
    expect(imp.selfTy.raw).toBe('Foo');
    expect(kindsOf(imp.items)).toEqual(['fn']);
  });

  it('reads a negative impl', () => {
    expect(only('impl !Send for Foo {}', 'impl')).toMatchObject({
      negative: true,
      trait: { raw: 'Send' },
      selfTy: { raw: 'Foo' },
    });
  });

  it('keeps a generic trait argument with `=` intact when finding `for`', () => {
    expect(only('impl Iterator<Item = u8> for X {}', 'impl')).toMatchObject({
      trait: { raw: 'Iterator < Item = u8 >' },
      selfTy: { raw: 'X' },
    });
  });

  it('reads an unsafe impl', () => {
    expect(only('unsafe impl Send for Foo {}', 'impl')).toMatchObject({
      unsafe: true,
      trait: { raw: 'Send' },
    });
  });

  it('reports an impl with no body and keeps the next item', () => {
    const file = parseRustFile('impl Foo;\nuse a;\n');
    expect(file.errors.map((e) => e.message)).toEqual(['expected `{` to open the body']);
    expect(kindsOf(file.items)).toEqual(['unknown', 'use']);
  });
});

describe('rust items: weak keywords', () => {
  it('treats auto as an identifier unless it starts an auto trait', () => {
    const file = parseRustFile('auto = 1;\n');
    expect(file.errors).toEqual([]);
    expect(file.items.map((i) => (i.kind === 'unknown' ? i.keyword : i.kind))).toEqual(['auto']);
  });
});
