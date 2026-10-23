import { describe, expect, it } from 'vitest';
import { parseRustFile } from '../items.js';
import { analyzeRustSymbols } from '../symbols.js';
import { bindCalls } from './calls.js';
import { bindImports } from './imports.js';
import { buildCrateIndex, type RustCrateIndex } from './module-index.js';
import { bindReferences } from './references.js';

const ENV = { externs: new Set<string>(), repoCrates: new Map() };

function crateOf(files: Record<string, string>): RustCrateIndex {
  const crate = buildCrateIndex({
    root: 'src/lib.rs',
    files: new Set(Object.keys(files)),
    readText: (file) => files[file] ?? '',
    edition: '2021',
  });
  bindImports(crate, ENV);
  return crate;
}

/** Each call edge as [from, to]. */
function callPairs(files: Record<string, string>): [string, string][] {
  return bindCalls([crateOf(files)], ENV).edges.map((edge) => [edge.from, edge.to]);
}

describe('nested items: symbols', () => {
  it('names a nested function under its enclosing function', () => {
    const ids = analyzeRustSymbols(
      parseRustFile('fn outer() { fn inner() {} }'),
      'src/lib.rs',
    ).declarations.map((declaration) => declaration.id);
    expect(ids).toEqual(expect.arrayContaining(['src/lib.rs:outer', 'src/lib.rs:outer::inner']));
  });
});

describe('nested items: calls', () => {
  it('gives the outer function the call to its nested function, and the nested function its own calls', () => {
    const pairs = callPairs({
      'src/lib.rs': 'fn helper() {} fn outer() { fn inner() { helper(); } inner(); }',
    });
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual(
      expect.arrayContaining([
        ['src/lib.rs:outer', 'src/lib.rs:outer::inner'],
        ['src/lib.rs:outer::inner', 'src/lib.rs:helper'],
      ]),
    );
  });

  it("does not credit a nested function's calls to the outer function", () => {
    const pairs = callPairs({
      'src/lib.rs': 'fn outer() { fn inner() { helper(); } } fn helper() {}',
    });
    expect(pairs).toEqual([['src/lib.rs:outer::inner', 'src/lib.rs:helper']]);
  });

  it('keeps a nested function name out of the scope around its block', () => {
    const pairs = callPairs({
      'src/lib.rs': 'fn outer() { fn inner() {} } fn other() { inner(); }',
    });
    expect(pairs).toEqual([]);
  });
});

describe('nested items: references', () => {
  it('gives a nested function a reference to a struct declared in the same block', () => {
    const results = bindReferences(
      [crateOf({ 'src/lib.rs': 'fn outer() { struct S; fn make() -> S { S } }' })],
      ENV,
    );
    expect(results.edges.map((edge) => [edge.from, edge.to])).toEqual(
      expect.arrayContaining([['src/lib.rs:outer::make', 'src/lib.rs:outer::S']]),
    );
  });
});

describe('nested items in inner blocks', () => {
  it('names an item declared in an inner block under the function', () => {
    const ids = analyzeRustSymbols(
      parseRustFile('fn outer(x: bool) { if x { fn inner() {} } }'),
      'src/lib.rs',
    ).declarations.map((declaration) => declaration.id);
    expect(ids).toEqual(expect.arrayContaining(['src/lib.rs:outer::inner']));
  });

  it('gives a call inside the inner block to the item declared there', () => {
    const pairs = callPairs({
      'src/lib.rs': 'fn outer(x: bool) { if x { fn inner() {} inner(); } }',
    });
    expect(pairs).toEqual([['src/lib.rs:outer', 'src/lib.rs:outer::inner']]);
  });

  it('keeps the item out of the rest of the function', () => {
    const pairs = callPairs({
      'src/lib.rs': 'fn outer(x: bool) { if x { fn inner() {} } inner(); }',
    });
    expect(pairs).toEqual([]);
  });
});

describe('nested items in const and static values', () => {
  it('names an item declared in a const value under the const', () => {
    const ids = analyzeRustSymbols(
      parseRustFile('const C: i32 = { fn helper() -> i32 { 1 } helper() };'),
      'src/lib.rs',
    ).declarations.map((declaration) => declaration.id);
    expect(ids).toEqual(expect.arrayContaining(['src/lib.rs:C::helper']));
  });

  it('gives a reference from a nested item in a static value to its nested type', () => {
    const results = bindReferences(
      [
        crateOf({
          'src/lib.rs': 'static S: i32 = { struct T; fn make() -> T { T } 1 };',
        }),
      ],
      ENV,
    );
    expect(results.edges.map((edge) => [edge.from, edge.to])).toEqual([
      ['src/lib.rs:S::make', 'src/lib.rs:S::T'],
    ]);
  });
});

describe('nested items: extern blocks in a body', () => {
  it('declares a function of an extern block in a body under the function', () => {
    const ids = analyzeRustSymbols(
      parseRustFile('fn outer() { extern "C" { fn puts(s: i32); } }'),
      'src/lib.rs',
    ).declarations.map((declaration) => declaration.id);
    expect(ids).toEqual(expect.arrayContaining(['src/lib.rs:outer::puts']));
  });

  it('gives a call to that function from the body to the nested declaration', () => {
    const pairs = callPairs({
      'src/lib.rs': 'fn outer() { extern "C" { fn puts(s: i32); } unsafe { puts(1) } }',
    });
    expect(pairs).toEqual([['src/lib.rs:outer', 'src/lib.rs:outer::puts']]);
  });
});
