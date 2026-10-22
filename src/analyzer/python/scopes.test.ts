import { describe, expect, it } from 'vitest';
import { analyzeScopes, type NameUse, type Resolution, type ScopeAnalysis } from './scopes.js';
import { parseModule } from './statement-parser.js';

function analyze(source: string): ScopeAnalysis {
  return analyzeScopes(parseModule(source));
}

/** A readable form of one resolution: a scope label, or `builtin:x`, `implicit:x`, `unresolved:why`. */
function show(a: ScopeAnalysis, r: Resolution): string {
  switch (r.kind) {
    case 'scope':
      return a.scopes[r.scope]?.label ?? `?${r.scope}`;
    case 'builtin':
      return `builtin:${r.name}`;
    case 'implicit':
      return `implicit:${r.name}`;
    case 'unresolved':
      return `unresolved:${r.reason}`;
  }
}

/** The resolutions of every use of `name`, in source order. */
function resolved(source: string, name: string): string[] {
  const a = analyze(source);
  return a.uses.filter((u: NameUse) => u.name === name).map((u) => show(a, u.resolution));
}

function bindingKinds(a: ScopeAnalysis, scopeLabel: string, name: string): string[] {
  const scope = a.scopes.find((s) => s.label === scopeLabel);
  return (scope?.bindings.get(name) ?? []).map((b) => b.kind);
}

describe('python scopes: LEGB lookup', () => {
  it('resolves a module name used inside a function to the module', () => {
    expect(resolved('x = 1\ndef f():\n    return x\n', 'x')).toEqual(['<module>']);
  });

  it('lets a local assignment shadow the module name', () => {
    expect(resolved('x = 1\ndef f():\n    x = 2\n    return x\n', 'x')).toEqual(['f']);
  });

  it('resolves a forward reference to the local binding, not the module', () => {
    expect(resolved('y = 0\ndef f():\n    print(y)\n    y = 1\n', 'y')).toEqual(['f']);
  });

  it('resolves a name in an enclosing function from a nested function', () => {
    const src = 'def outer():\n    v = 1\n    def inner():\n        return v\n    return inner\n';
    expect(resolved(src, 'v')).toEqual(['outer']);
  });

  it('reports a name bound nowhere as undefined, and a builtin as a builtin', () => {
    expect(resolved('print(zz)\nlen([])\n', 'zz')).toEqual(['unresolved:undefined']);
    expect(resolved('print(zz)\nlen([])\n', 'len')).toEqual(['builtin:len']);
  });

  it('resolves the interpreter-defined module names as implicit', () => {
    expect(resolved('def f():\n    return __name__\n', '__name__')).toEqual(['implicit:__name__']);
  });
});

describe('python scopes: class bodies', () => {
  it('lets code in a class body see names bound earlier in the same class body', () => {
    expect(resolved('class C:\n    a = 1\n    b = a\n', 'a')).toEqual(['C']);
  });

  it('does not expose class names to methods (negative)', () => {
    const src = 'class C:\n    a = 1\n    def m(self):\n        return a\n';
    expect(resolved(src, 'a')).toEqual(['unresolved:undefined']);
  });

  it('lets a class body see the names of the enclosing function', () => {
    const src = 'def f():\n    v = 1\n    class C:\n        w = v\n    return C\n';
    expect(resolved(src, 'v')).toEqual(['f']);
  });

  it('labels nested classes and methods with their qualified name', () => {
    const labels = analyze('class C:\n    def m(self):\n        pass\n').scopes.map((s) => s.label);
    expect(labels).toEqual(['<module>', 'C', 'C.m']);
  });

  it('binds a method name in the class scope, not the module', () => {
    const a = analyze('class C:\n    def m(self):\n        pass\n');
    expect(bindingKinds(a, '<module>', 'm')).toEqual([]);
    expect(bindingKinds(a, 'C', 'm')).toEqual(['def']);
  });
});

describe('python scopes: comprehensions and lambdas', () => {
  it('binds comprehension targets in the comprehension scope', () => {
    expect(resolved('def f(xs):\n    return [x for x in xs]\n', 'x')).toEqual(['<comprehension>']);
  });

  it('evaluates the first iterable in the enclosing scope', () => {
    expect(resolved('def f(xs):\n    return [x for x in xs]\n', 'xs')).toEqual(['f']);
  });

  it('lets a comprehension inside a class body reach the class name only through the first iterable', () => {
    const src = 'class C:\n    k = 1\n    xs = [1]\n    v = [k for _ in xs]\n';
    expect(resolved(src, 'k')).toEqual(['unresolved:undefined']);
    expect(resolved(src, 'xs')).toEqual(['C']);
  });

  it('binds a walrus target in a comprehension to the enclosing function', () => {
    const src = 'def f(xs):\n    [y := x for x in xs]\n    return y\n';
    expect(resolved(src, 'y')).toEqual(['f']);
    expect(bindingKinds(analyze(src), 'f', 'y')).toEqual(['walrus']);
  });

  it('binds lambda parameters in the lambda scope and reads outer names from the module', () => {
    const src = 'b = 1\nf = lambda a: a + b\n';
    expect(resolved(src, 'a')).toEqual(['<lambda>']);
    expect(resolved(src, 'b')).toEqual(['<module>']);
  });
});

describe('python scopes: global and nonlocal', () => {
  it('binds a global-declared assignment in the module scope', () => {
    const src = 'def f():\n    global g\n    g = 1\n    return g\n';
    const a = analyze(src);
    expect(bindingKinds(a, '<module>', 'g')).toEqual(['assign']);
    expect(bindingKinds(a, 'f', 'g')).toEqual([]);
    expect(resolved(src, 'g')).toEqual(['<module>']);
    expect(a.problems).toEqual([]);
  });

  it('binds a nonlocal-declared assignment in the enclosing function', () => {
    const src =
      'def outer():\n    n = 0\n    def inner():\n        nonlocal n\n        n += 1\n        return n\n    return inner\n';
    const a = analyze(src);
    expect(resolved(src, 'n')).toEqual(['outer', 'outer']);
    expect(bindingKinds(a, 'outer', 'n')).toEqual(['assign', 'augassign']);
    expect(a.problems).toEqual([]);
  });

  it('reports a nonlocal declaration with no enclosing binding', () => {
    const a = analyze('def f():\n    nonlocal q\n');
    expect(a.problems.map((p) => p.message)).toEqual(["no binding for nonlocal 'q' found"]);
  });

  it('reports nonlocal at module level', () => {
    const a = analyze('nonlocal q\n');
    expect(a.problems.map((p) => p.message)).toEqual(['nonlocal declaration at module level']);
  });

  it('skips class scopes when a nonlocal name is searched', () => {
    const src =
      'def outer():\n    n = 0\n    class C:\n        n = 5\n        def m(self):\n            nonlocal n\n            return n\n    return C\n';
    expect(resolved(src, 'n')).toEqual(['outer']);
  });
});

describe('python scopes: straight-line del', () => {
  it('leaves a module name unbound after a del at module level', () => {
    expect(resolved('x = 1\ndel x\nprint(x)\n', 'x')).toEqual(['<module>', 'unresolved:undefined']);
  });

  it('leaves a function local unbound after a del in the function', () => {
    expect(resolved('def f():\n    x = 1\n    del x\n    return x\n', 'x')).toEqual([
      'f',
      'unresolved:undefined',
    ]);
  });

  it('falls back to a built-in after a del of a shadowing module name', () => {
    expect(resolved("print = 1\ndel print\nprint('a')\n", 'print')).toEqual([
      '<module>',
      'builtin:print',
    ]);
  });

  it('falls back to the module name inside a class body after a del of a class name', () => {
    expect(resolved('x = 1\nclass C:\n    x = 2\n    del x\n    y = x\n', 'x')).toEqual([
      'C',
      '<module>',
    ]);
  });

  it('keeps the name bound after a del in a branch (negative)', () => {
    expect(resolved('x = 1\nif c:\n    del x\nprint(x)\n', 'x')).toEqual(['<module>', '<module>']);
  });

  it('keeps the name bound when it is assigned again after the del', () => {
    expect(resolved('x = 1\ndel x\nx = 2\nprint(x)\n', 'x')).toEqual(['<module>', '<module>']);
  });

  it('keeps the module name bound in a nested function, which runs later (negative)', () => {
    expect(resolved('x = 1\ndel x\ndef g():\n    return x\n', 'x')).toEqual([
      '<module>',
      '<module>',
    ]);
  });
});

describe('python scopes: deletion and star imports', () => {
  it('makes a name deleted in a function local to that function', () => {
    const src = 'x = 1\ndef f():\n    del x\n';
    expect(resolved(src, 'x')).toEqual(['f']);
    const [use] = analyze(src).uses.filter((u) => u.name === 'x');
    expect(use?.access).toBe('delete');
  });

  it('reports every name as unresolved after a star import, which can shadow builtins (negative)', () => {
    expect(resolved('from os import *\nprint(path)\n', 'path')).toEqual(['unresolved:star-import']);
    expect(resolved('from os import *\nprint(path)\n', 'print')).toEqual([
      'unresolved:star-import',
    ]);
  });

  it('keeps a local binding ahead of a star import', () => {
    expect(resolved('from os import *\npath = 1\nprint(path)\n', 'path')).toEqual(['<module>']);
  });
});

describe('python scopes: binding forms', () => {
  it('binds import names, using the first component for a dotted import', () => {
    const a = analyze('import a.b.c\nfrom x import y as z\n');
    expect(bindingKinds(a, '<module>', 'a')).toEqual(['import']);
    expect(bindingKinds(a, '<module>', 'z')).toEqual(['import']);
    expect(bindingKinds(a, '<module>', 'y')).toEqual([]);
  });

  it('records every definition of a conditionally defined name', () => {
    const src = 'if c:\n    def f():\n        pass\nelse:\n    def f():\n        pass\nf()\n';
    expect(bindingKinds(analyze(src), '<module>', 'f')).toEqual(['def', 'def']);
  });

  it('binds except names and match captures, and leaves wildcards alone', () => {
    const src =
      'try:\n    pass\nexcept E as e:\n    print(e)\nmatch p:\n    case [a, *rest] if a:\n        pass\n    case {**kw}:\n        pass\n    case _:\n        pass\n';
    const a = analyze(src);
    expect(bindingKinds(a, '<module>', 'e')).toEqual(['except']);
    expect(bindingKinds(a, '<module>', 'a')).toEqual(['match']);
    expect(bindingKinds(a, '<module>', 'rest')).toEqual(['match']);
    expect(bindingKinds(a, '<module>', 'kw')).toEqual(['match']);
    expect(bindingKinds(a, '<module>', '_')).toEqual([]);
  });

  it('binds a with target', () => {
    expect(bindingKinds(analyze('with open(p) as fh:\n    pass\n'), '<module>', 'fh')).toEqual([
      'with',
    ]);
  });

  it('evaluates decorators and default values in the enclosing scope', () => {
    const src = '@deco\ndef f(a=d):\n    return a\n';
    const a = analyze(src);
    const deco = a.uses.find((u) => u.name === 'deco');
    const d = a.uses.find((u) => u.name === 'd');
    expect(deco?.scope).toBe(0);
    expect(d?.scope).toBe(0);
    expect(resolved(src, 'a')).toEqual(['f']);
  });

  it('binds PEP 695 type parameters in their own scope', () => {
    const src = 'def f[T](x: T) -> T:\n    return x\n';
    expect(resolved(src, 'T')).toEqual(['<type-params>', '<type-params>']);
    const a = analyze(src);
    const t = a.uses.find((u) => u.name === 'T');
    const kind = t?.resolution.kind === 'scope' ? t.resolution.scopeKind : undefined;
    expect(kind).toBe('type-params');
  });

  it('binds a type alias statement name in the enclosing scope', () => {
    expect(bindingKinds(analyze('type X = list[int]\n'), '<module>', 'X')).toEqual(['type-alias']);
  });
});
