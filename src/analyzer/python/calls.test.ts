import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { createImportResolver } from './modules/import-resolution.js';
import { createSymbolResolver } from './modules/module-exports.js';
import { ModuleIndex } from './modules/module-index.js';
import { analyzePythonCalls, type CallAnalysis } from './calls.js';

const FIXTURE = path.resolve(__dirname, '../../../test/fixtures/python-baseline');

function run(files: Record<string, string>): CallAnalysis {
  const index = new ModuleIndex(Object.keys(files));
  const readText = (p: string): string => files[p] ?? '';
  const imports = createImportResolver(index, { roots: ['.'], readText });
  const symbols = createSymbolResolver({ resolver: imports, readText });
  return analyzePythonCalls(
    Object.entries(files).map(([filePath, source]) => ({ filePath, source })),
    { symbols, imports },
  );
}

/** One line per call: `owner -> callee [role]`, with `<module>` for module-level code. */
function edges(r: CallAnalysis): string[] {
  return r.calls.map((c) => {
    const callee = c.callee.kind === 'symbol' ? c.callee.id : c.callee.kind;
    return `${c.owner ?? '<module>'} -> ${callee} [${c.role}]`;
  });
}

describe('python calls: names and module attributes', () => {
  it('resolves a call to a function in the same module, owned by the caller', () => {
    expect(edges(run({ 'm.py': 'def helper():\n    pass\ndef main():\n    helper()\n' }))).toEqual([
      'm.py:main -> m.py:helper [call]',
    ]);
  });

  it('resolves a call to a from-imported function', () => {
    const r = run({
      'pipeline/util.py': 'def helper():\n    pass\n',
      'main.py': 'from pipeline.util import helper\ndef main():\n    helper()\n',
    });
    expect(edges(r)).toEqual(['main.py:main -> pipeline/util.py:helper [call]']);
  });

  it('resolves a call through a module attribute', () => {
    const r = run({
      'pkg/mod.py': 'def g():\n    pass\n',
      'main.py': 'import pkg.mod as m\ndef f():\n    m.g()\n',
    });
    expect(edges(r)).toEqual(['main.py:f -> pkg/mod.py:g [call]']);
  });

  it('records a call at module level with no owner', () => {
    expect(edges(run({ 'm.py': 'def g():\n    pass\ng()\n' }))).toEqual([
      '<module> -> m.py:g [call]',
    ]);
  });

  it('records a call nested in an expression, owned by the enclosing function', () => {
    expect(
      edges(
        run({ 'm.py': 'def g(x):\n    return x\ndef f():\n    return [g(x) for x in range(2)]\n' }),
      ),
    ).toEqual(['m.py:f -> m.py:g [call]']);
  });
});

describe('python calls: classes and constructors', () => {
  it('records a construct for a class call', () => {
    expect(edges(run({ 'm.py': 'class User:\n    pass\ndef f():\n    User()\n' }))).toEqual([
      'm.py:f -> m.py:User [construct]',
    ]);
  });

  it('also records a call to __init__ when the class defines one', () => {
    expect(
      edges(
        run({
          'm.py': 'class User:\n    def __init__(self):\n        pass\ndef f():\n    User()\n',
        }),
      ),
    ).toEqual(['m.py:f -> m.py:User [construct]', 'm.py:f -> m.py:User.__init__ [call]']);
  });

  it('resolves a method called through its class', () => {
    expect(
      edges(run({ 'm.py': 'class C:\n    def m():\n        pass\ndef f():\n    C.m()\n' })),
    ).toEqual(['m.py:f -> m.py:C.m [call]']);
  });

  it('resolves a nested class called through its outer class', () => {
    expect(
      edges(
        run({
          'm.py': 'class Outer:\n    class Inner:\n        pass\ndef f():\n    Outer.Inner()\n',
        }),
      ),
    ).toEqual(['m.py:f -> m.py:Outer.Inner [construct]']);
  });
});

describe('python calls: self, cls and super through the MRO', () => {
  it('resolves self.m() to a method of the same class', () => {
    const src = 'class C:\n    def a(self):\n        pass\n    def b(self):\n        self.a()\n';
    expect(edges(run({ 'm.py': src }))).toEqual(['m.py:C.b -> m.py:C.a [call]']);
  });

  it('resolves self.m() to a method inherited from a base class', () => {
    const src =
      'class Base:\n    def a(self):\n        pass\nclass C(Base):\n    def b(self):\n        self.a()\n';
    expect(edges(run({ 'm.py': src }))).toEqual(['m.py:C.b -> m.py:Base.a [call]']);
  });

  it('resolves cls.m() inside a classmethod', () => {
    const src =
      'class C:\n    def build(cls):\n        pass\n    @classmethod\n    def make(cls):\n        cls.build()\n';
    expect(edges(run({ 'm.py': src }))).toEqual(['m.py:C.make -> m.py:C.build [call]']);
  });

  it('resolves super().m() to the next method after the class in the MRO', () => {
    const src =
      'class Base:\n    def m(self):\n        pass\nclass C(Base):\n    def m(self):\n        super().m()\n';
    expect(edges(run({ 'm.py': src }))).toEqual(['m.py:C.m -> m.py:Base.m [call]']);
  });

  it('emits no edge for self.m() when no class in the MRO defines m (negative)', () => {
    expect(edges(run({ 'm.py': 'class C:\n    def b(self):\n        self.missing()\n' }))).toEqual(
      [],
    );
  });

  it('emits no edge for a method call on a static method receiver (negative)', () => {
    const src =
      'class C:\n    def a(self):\n        pass\n    @staticmethod\n    def s(self):\n        self.a()\n';
    expect(edges(run({ 'm.py': src }))).toEqual([]);
  });
});

describe('python calls: what is not resolved', () => {
  it('emits no edge for a method on a receiver of unknown type (negative)', () => {
    expect(edges(run({ 'm.py': 'def f(x):\n    x.run()\n' }))).toEqual([]);
  });

  it('lets a parameter shadow a module function of the same name (negative)', () => {
    const r = run({
      'u.py': 'def helper():\n    pass\n',
      'm.py': 'from u import helper\ndef f(helper):\n    helper()\n',
    });
    expect(edges(r)).toEqual([]);
  });

  it('emits no edge for a call into an external package (negative)', () => {
    expect(edges(run({ 'm.py': 'import json\ndef f():\n    json.dumps(1)\n' }))).toEqual([]);
  });

  it('emits no edge for a call to a name bound to a value, not a function', () => {
    expect(edges(run({ 'm.py': 'handler = None\ndef f():\n    handler()\n' }))).toEqual([]);
  });
});

describe('python calls: baseline floor', () => {
  it('keeps every baseline call edge', () => {
    const files: Record<string, string> = {};
    for (const name of [
      'app.py',
      'broken.py',
      'pipeline/__init__.py',
      'pipeline/models.py',
      'pipeline/normalize.py',
      'pipeline/util.py',
      'scripts/collect.py',
    ]) {
      files[name] = fs.readFileSync(path.join(FIXTURE, name), 'utf8');
    }
    expect(edges(run(files))).toEqual(
      expect.arrayContaining([
        'app.py:main -> pipeline/models.py:User [construct]',
        'pipeline/models.py:User.save -> pipeline/util.py:helper [call]',
        'pipeline/normalize.py:run -> pipeline/util.py:helper [call]',
        'scripts/collect.py:main -> pipeline/normalize.py:run [call]',
      ]),
    );
  });
});
