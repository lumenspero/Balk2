import { describe, expect, it } from 'vitest';
import { parseRustFile } from './items.js';
import { analyzeRustSymbols } from './symbols.js';

const FILE = 'src/m.rs';

function analyze(source: string, filePath = FILE): ReturnType<typeof analyzeRustSymbols> {
  return analyzeRustSymbols(parseRustFile(source), filePath);
}

function summary(source: string): [string, string][] {
  return analyze(source).declarations.map((d) => [d.name, d.symbolType]);
}

describe('analyzeRustSymbols: item kinds', () => {
  it('declares each top-level item kind with its symbol type', () => {
    expect(
      summary(`
pub fn parse() {}
struct User;
struct Point(u8, u8);
struct Config { a: u8 }
enum Mode { A }
union Bits { a: u32 }
trait Render {}
type Id = u32;
const MAX: u32 = 1;
static mut COUNTER: u32 = 0;
macro_rules! my_macro { () => {} }
`),
    ).toEqual([
      ['parse', 'function'],
      ['User', 'struct'],
      ['Point', 'struct'],
      ['Config', 'struct'],
      ['Mode', 'enum'],
      ['Mode.A', 'variant'],
      ['Bits', 'struct'],
      ['Render', 'trait'],
      ['Id', 'type'],
      ['MAX', 'constant'],
      ['COUNTER', 'variable'],
      ['my_macro!', 'macro'],
    ]);
  });

  it('declares the functions of an extern block', () => {
    expect(summary('extern "C" { fn puts(s: *const u8) -> i32; }')).toEqual([['puts', 'function']]);
  });

  it('declares nothing for use, extern crate or a module loaded from another file', () => {
    expect(summary('use std::fmt; extern crate core; mod other;')).toEqual([]);
  });
});

describe('analyzeRustSymbols: visibility and ids', () => {
  it('maps pub, pub(crate) and private to public, module and private', () => {
    const visibility = analyze('pub fn a() {} pub(crate) fn b() {} fn c() {}').declarations.map(
      (d) => d.visibility,
    );
    expect(visibility).toEqual(['public', 'module', 'private']);
  });

  it('gives each declaration the file-qualified id and no export', () => {
    const [first] = analyze('pub fn parse() {}').declarations;
    expect(first?.id).toBe('src/m.rs:parse');
    expect(first?.exported).toBe(false);
    expect(first?.owner).toBeNull();
  });

  it('gives a same-named struct and function different ids, with #n for the second', () => {
    const { declarations, namespaces } = analyze('struct Foo { x: u8 } fn Foo() {}');
    expect(declarations.map((d) => d.name)).toEqual(['Foo', 'Foo#2']);
    const root = namespaces.get(FILE);
    expect(root?.type.get('Foo')).toBe('src/m.rs:Foo');
    expect(root?.value.get('Foo')).toBe('src/m.rs:Foo#2');
  });

  it('treats a tuple struct as a value too, so a same-named function clashes', () => {
    expect(analyze('struct Point(u8); fn Point() {}').declarations.map((d) => d.name)).toEqual([
      'Point',
      'Point#2',
    ]);
  });

  it('keeps cfg twins as one id, each with its condition', () => {
    const { declarations } = analyze('#[cfg(unix)] fn run() {}\n#[cfg(windows)] fn run() {}');
    expect(declarations.map((d) => d.id)).toEqual(['src/m.rs:run', 'src/m.rs:run']);
    expect(declarations.every((d) => d.condition?.includes('cfg'))).toBe(true);
    expect(declarations[0]?.condition).toContain('unix');
    expect(declarations[1]?.condition).toContain('windows');
  });
});

describe('analyzeRustSymbols: methods and traits', () => {
  it('names inherent, trait and trait-impl methods by their owner', () => {
    const { declarations } = analyze(`
struct User { id: u32 }
impl User { pub fn save(&self) {} fn load() {} }
trait Render { fn render(&self); }
impl std::fmt::Display for User { fn fmt(&self) {} }
impl<T> Wrapper<T> { fn get(&self) {} }
`);
    expect(declarations.map((d) => [d.name, d.symbolType, d.visibility])).toEqual([
      ['User', 'struct', 'private'],
      ['User.save', 'method', 'public'],
      ['User.load', 'method', 'private'],
      ['Render', 'trait', 'private'],
      ['Render.render', 'method', 'private'],
      ['User[Display].fmt', 'method', 'public'],
      ['Wrapper.get', 'method', 'private'],
    ]);
    expect(declarations.find((d) => d.name === 'User.save')?.owner).toBe('src/m.rs:User');
    expect(declarations.find((d) => d.name === 'Render.render')?.owner).toBe('src/m.rs:Render');
  });

  it('declares no method for an impl on a type it cannot name', () => {
    expect(summary('impl Trait for &Bar { fn go(&self) {} }')).toEqual([]);
  });

  it('does not declare associated consts or types as methods', () => {
    expect(summary('struct A; impl A { const N: u8 = 1; type T = u8; }')).toEqual([
      ['A', 'struct'],
    ]);
  });
});

describe('analyzeRustSymbols: inline modules', () => {
  it('names items inside an inline module with ::, and records them in its scope', () => {
    const { declarations, namespaces } = analyze(
      'mod tests { fn helper() {} struct Inner; }',
      'src/lib.rs',
    );
    expect(declarations.map((d) => [d.name, d.symbolType])).toEqual([
      ['tests', 'module'],
      ['tests::helper', 'function'],
      ['tests::Inner', 'struct'],
    ]);
    expect(namespaces.get('src/lib.rs')?.type.get('tests')).toBe('src/lib.rs:tests');
    expect(namespaces.get('src/lib.rs:tests')?.value.get('helper')).toBe(
      'src/lib.rs:tests::helper',
    );
  });

  it('records the cfg of an enclosing module on its items', () => {
    const [, helper] = analyze('#[cfg(test)] mod tests { fn helper() {} }').declarations;
    expect(helper?.condition).toContain('test');
  });
});

describe('analyzeRustSymbols: robustness', () => {
  it('still declares valid items around malformed input and never throws', () => {
    const names = analyze('fn ok() {} fn ( ((( struct Good;').declarations.map((d) => d.name);
    expect(names).toContain('ok');
  });
});
