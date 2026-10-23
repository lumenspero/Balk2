import { describe, expect, it } from 'vitest';
import { bindCalls } from './calls.js';
import { bindImports } from './imports.js';
import { buildCrateIndex, type RustCrateIndex } from './module-index.js';
import { bindReferences, type ReferenceResults } from './references.js';

const ENV = { externs: new Set<string>(['serde']), repoCrates: new Map() };

function crateOf(files: Record<string, string>, edition = '2021'): RustCrateIndex {
  const crate = buildCrateIndex({
    root: 'src/lib.rs',
    files: new Set(Object.keys(files)),
    readText: (file) => files[file] ?? '',
    edition,
  });
  bindImports(crate, ENV);
  return crate;
}

function refsOf(files: Record<string, string>): ReferenceResults {
  return bindReferences([crateOf(files)], ENV);
}

/** Each reference edge as [from, to]. */
function pairsOf(results: ReferenceResults): [string, string][] {
  return results.edges.map((edge) => [edge.from, edge.to]);
}

describe('bindReferences: types in signatures and fields', () => {
  it('gives a struct field a reference to the struct it names', () => {
    const results = refsOf({ 'src/lib.rs': 'pub struct A; pub struct B { a: A }' });
    expect(pairsOf(results)).toEqual([['src/lib.rs:B', 'src/lib.rs:A']]);
    expect(results.unresolved).toEqual([]);
  });

  it('reads a name inside generic arguments', () => {
    const results = refsOf({ 'src/lib.rs': 'pub struct A; pub struct B { v: Vec<A> }' });
    expect(pairsOf(results)).toEqual([['src/lib.rs:B', 'src/lib.rs:A']]);
  });

  it('gives a function a reference from its signature and its let annotations', () => {
    const results = refsOf({
      'src/lib.rs': 'pub struct A; fn f(a: &A) -> Option<A> { let _b: A = make(); None }',
    });
    expect(pairsOf(results)).toEqual([['src/lib.rs:f', 'src/lib.rs:A']]);
  });

  it('gives an enum variant its own references, not the enum', () => {
    const results = refsOf({ 'src/lib.rs': 'pub struct A; pub enum E { V(A), W }' });
    expect(pairsOf(results)).toEqual([['src/lib.rs:E.V', 'src/lib.rs:A']]);
  });

  it('gives a generic bound a reference to its trait, and skips the generic name itself', () => {
    const results = refsOf({ 'src/lib.rs': 'pub trait R {} pub struct W<T: R>(pub T);' });
    expect(pairsOf(results)).toEqual([['src/lib.rs:W', 'src/lib.rs:R']]);
  });

  it('gives a const a reference from its type and its value', () => {
    const results = refsOf({
      'src/lib.rs': 'pub struct A { x: u8 } pub const C: A = A { x: 1 };',
    });
    expect(pairsOf(results)).toEqual([['src/lib.rs:C', 'src/lib.rs:A']]);
  });
});

describe('bindReferences: values in bodies', () => {
  it('gives a struct literal a reference to its struct', () => {
    const results = refsOf({
      'src/lib.rs': 'pub struct A { x: u8 } fn f() -> A { A { x: 1 } }',
    });
    expect(pairsOf(results)).toEqual(expect.arrayContaining([['src/lib.rs:f', 'src/lib.rs:A']]));
  });

  it('gives an enum variant path a reference to the variant, and the signature one to the enum', () => {
    const results = refsOf({ 'src/lib.rs': 'pub enum E { V, W } fn f() -> E { E::V }' });
    expect(pairsOf(results)).toEqual(
      expect.arrayContaining([
        ['src/lib.rs:f', 'src/lib.rs:E'],
        ['src/lib.rs:f', 'src/lib.rs:E.V'],
      ]),
    );
  });

  it('gives a tuple-struct constructor a reference to the struct', () => {
    const results = refsOf({ 'src/lib.rs': 'pub struct T(pub u8); fn f() { T(1); }' });
    expect(pairsOf(results)).toEqual([['src/lib.rs:f', 'src/lib.rs:T']]);
  });
});

describe('bindCalls: extern block functions', () => {
  it('resolves a call to a function in an extern block to its declaration', () => {
    const crate = crateOf({ 'src/lib.rs': 'extern "C" { fn ext(x: i32); } fn f() { ext(1); }' });
    const results = bindCalls([crate], ENV);
    expect(results.edges.map((edge) => [edge.from, edge.to])).toEqual([
      ['src/lib.rs:f', 'src/lib.rs:ext'],
    ]);
  });
});

describe('crate index: functions and abi', () => {
  it('records the ABI of a #[no_mangle] extern function', () => {
    const crate = crateOf({ 'src/lib.rs': '#[no_mangle] pub extern "C" fn f() {}' });
    const [fn] = crate.functions;
    expect(fn?.noMangle).toBe(true);
    expect(fn?.abi).not.toBeNull();
  });
});

describe('bindImports: a leading ::', () => {
  it('resolves ::name from the crate root in edition 2015', () => {
    const crate = crateOf(
      {
        'src/lib.rs': 'pub mod util; mod a { use ::util::helper; }',
        'src/util.rs': 'pub fn helper() {}',
      },
      '2015',
    );
    const result = bindImports(crate, ENV);
    expect(result.edges.map((edge) => edge.target)).toEqual(['src/util.rs']);
  });
});
