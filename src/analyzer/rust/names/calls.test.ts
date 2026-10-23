import { describe, expect, it } from 'vitest';
import { bindCalls, type CallResults } from './calls.js';
import { bindImports } from './imports.js';
import { buildCrateIndex, type RustCrateIndex } from './module-index.js';

const ENV = { externs: new Set<string>(), repoCrates: new Map() };

function callsOf(files: Record<string, string>): CallResults {
  const crate: RustCrateIndex = buildCrateIndex({
    root: 'src/lib.rs',
    files: new Set(Object.keys(files)),
    readText: (file) => files[file] ?? '',
    edition: '2021',
  });
  bindImports(crate, ENV);
  return bindCalls([crate], ENV);
}

/** Each edge as [from, to, confidence, dispatch]. */
function edgesOf(results: CallResults): [string, string, string, boolean][] {
  return results.edges.map((edge) => [edge.from, edge.to, edge.confidence, edge.dispatch]);
}

const FOO = 'pub struct Foo; impl Foo { pub fn new() -> Self { Foo } pub fn b(&self) {} }';

describe('bindCalls: path calls', () => {
  it('resolves a call to a function in the same file', () => {
    const results = callsOf({
      'src/lib.rs': 'fn helper() {} fn main() { helper(); }',
    });
    expect(edgesOf(results)).toEqual([['src/lib.rs:main', 'src/lib.rs:helper', 'high', false]]);
    expect(results.edges[0]?.spans).toHaveLength(1);
  });

  it('resolves a call through a use binding into another module', () => {
    const results = callsOf({
      'src/lib.rs': 'pub mod util; use util::helper; fn main() { helper(); }',
      'src/util.rs': 'pub fn helper() {}',
    });
    expect(edgesOf(results)).toEqual([['src/lib.rs:main', 'src/util.rs:helper', 'high', false]]);
  });

  it('does not resolve a call whose name is a local binding', () => {
    const results = callsOf({
      'src/lib.rs': 'fn helper() {} fn main() { let helper = || {}; helper(); }',
    });
    expect(results.edges).toEqual([]);
  });
});

describe('bindCalls: associated functions and methods', () => {
  it('resolves Type::name to the inherent method at high confidence', () => {
    const results = callsOf({ 'src/lib.rs': `${FOO} fn main() { Foo::new(); }` });
    expect(edgesOf(results)).toEqual([['src/lib.rs:main', 'src/lib.rs:Foo.new', 'high', false]]);
  });

  it('resolves Type::name to the one trait impl at medium confidence', () => {
    const results = callsOf({
      'src/lib.rs':
        'pub struct Foo; pub trait Make { fn make() -> Self; } impl Make for Foo { fn make() -> Self { Foo } } fn main() { Foo::make(); }',
    });
    expect(edgesOf(results)).toEqual([
      ['src/lib.rs:main', 'src/lib.rs:Foo[Make].make', 'medium', false],
    ]);
  });

  it('gives no edge when two trait impls both give Type the name', () => {
    const results = callsOf({
      'src/lib.rs':
        'pub struct Foo; pub trait A { fn m(); } pub trait B { fn m(); } impl A for Foo { fn m() {} } impl B for Foo { fn m() {} } fn main() { Foo::m(); }',
    });
    expect(results.edges).toEqual([]);
  });

  it('resolves self.m() and Self::name() within the enclosing impl', () => {
    const results = callsOf({
      'src/lib.rs': `${FOO} impl Foo { fn a(&self) { self.b(); Self::new(); } }`,
    });
    expect(edgesOf(results)).toEqual(
      expect.arrayContaining([
        ['src/lib.rs:Foo.a', 'src/lib.rs:Foo.b', 'high', false],
        ['src/lib.rs:Foo.a', 'src/lib.rs:Foo.new', 'high', false],
      ]),
    );
  });
});

describe('bindCalls: typed receivers', () => {
  it('uses an annotated parameter, peeling a reference, at high confidence', () => {
    const results = callsOf({
      'src/lib.rs': `${FOO} fn run(f: &mut Foo) { f.b(); }`,
    });
    expect(edgesOf(results)).toEqual([['src/lib.rs:run', 'src/lib.rs:Foo.b', 'high', false]]);
  });

  it('uses a constructor result at medium confidence', () => {
    const results = callsOf({
      'src/lib.rs': `${FOO} fn main() { let f = Foo::new(); f.b(); }`,
    });
    expect(edgesOf(results)).toEqual(
      expect.arrayContaining([
        ['src/lib.rs:main', 'src/lib.rs:Foo.new', 'high', false],
        ['src/lib.rs:main', 'src/lib.rs:Foo.b', 'medium', false],
      ]),
    );
  });

  it('gives no edge for a receiver of unknown type', () => {
    const results = callsOf({
      'src/lib.rs': `${FOO} fn main() { let x = unknown(); x.b(); }`,
    });
    expect(results.edges).toEqual([]);
  });

  it('resolves a dyn receiver to the trait method with dispatch', () => {
    const results = callsOf({
      'src/lib.rs':
        'pub trait Render { fn render(&self); } fn show(r: &dyn Render) { r.render(); }',
    });
    expect(edgesOf(results)).toEqual([
      ['src/lib.rs:show', 'src/lib.rs:Render.render', 'high', true],
    ]);
  });

  it('resolves a generic receiver with one trait bound to the trait method', () => {
    const results = callsOf({
      'src/lib.rs':
        'pub trait Render { fn render(&self); } fn show<T: Render>(t: T) { t.render(); }',
    });
    expect(edgesOf(results)).toEqual([
      ['src/lib.rs:show', 'src/lib.rs:Render.render', 'high', true],
    ]);
  });

  it('resolves self.m() inside a trait default method to the trait method', () => {
    const results = callsOf({
      'src/lib.rs': 'pub trait T { fn a(&self) { self.b(); } fn b(&self); }',
    });
    expect(edgesOf(results)).toEqual([['src/lib.rs:T.a', 'src/lib.rs:T.b', 'high', true]]);
  });
});
