import { describe, expect, it } from 'vitest';
import type { FactTarget } from '../../../facts/types.js';
import { createImportResolver } from './import-resolution.js';
import { ModuleIndex } from './module-index.js';
import { createSymbolResolver, type ModuleExport, type SymbolResolver } from './module-exports.js';

function symbols(files: Record<string, string>, roots: string[] = ['.']): SymbolResolver {
  const index = new ModuleIndex(Object.keys(files));
  const readText = (path: string): string => files[path] ?? '';
  const resolver = createImportResolver(index, { roots, readText });
  return createSymbolResolver({ resolver, readText });
}

const sym = (id: string): FactTarget => ({ kind: 'symbol', id });

function names(exported: ModuleExport[]): string[] {
  return exported.map((entry) => entry.name);
}

describe('exports of a plain module', () => {
  it('exports public declared names, and not imports, underscore names, or star-imported names', () => {
    const resolver = symbols({
      'mod.py': 'import os\nfrom x import y\n_private = 1\nC = 2\n\ndef f():\n    pass\n',
      'x.py': 'y = 0\n',
    });
    expect(names(resolver.exportsOf('mod.py'))).toEqual(['C', 'f']);
    expect(resolver.exportsOf('mod.py').every((entry) => !entry.reexport)).toBe(true);
  });

  it('exports a redundant-alias import as a re-export', () => {
    const resolver = symbols({
      'a.py': 'from b import Y as Y\nfrom b import Z\n',
      'b.py': 'Y = 1\nZ = 2\n',
    });
    expect(resolver.exportsOf('a.py')).toEqual([
      { name: 'Y', origin: sym('b.py:Y'), reexport: true },
    ]);
  });
});

describe('exports of a package __init__', () => {
  it('re-exports the names it imports, and resolves each to its declaration', () => {
    const resolver = symbols({
      'pkg/__init__.py': 'from .core import Thing\nfrom .core import helper as helper\n',
      'pkg/core.py':
        'class Thing:\n    pass\n\ndef helper():\n    pass\n\ndef hidden():\n    pass\n',
    });
    expect(resolver.exportsOf('pkg/__init__.py')).toEqual([
      { name: 'Thing', origin: sym('pkg/core.py:Thing'), reexport: true },
      { name: 'helper', origin: sym('pkg/core.py:helper'), reexport: true },
    ]);
  });

  it('re-exports a submodule as a file origin', () => {
    const resolver = symbols({ 'pkg/__init__.py': 'from . import core\n', 'pkg/core.py': '' });
    expect(resolver.exportsOf('pkg/__init__.py')).toEqual([
      { name: 'core', origin: { kind: 'file', path: 'pkg/core.py' }, reexport: true },
    ]);
  });

  it('re-exports the public names of a star import', () => {
    const resolver = symbols({
      'pkg/__init__.py': 'from .core import *\n',
      'pkg/core.py': '__all__ = ["A"]\nA = 1\nB = 2\n',
    });
    expect(resolver.exportsOf('pkg/__init__.py')).toEqual([
      { name: 'A', origin: sym('pkg/core.py:A'), reexport: true },
    ]);
  });
});

describe('static __all__', () => {
  it('takes exports from __all__, including imported names, and reports dangling names', () => {
    const resolver = symbols({
      'pkg2.py': '__all__ = ["Y", "missing"]\nfrom b import Y\n',
      'b.py': 'Y = 1\n',
    });
    expect(resolver.exportsOf('pkg2.py')).toEqual([
      { name: 'Y', origin: sym('b.py:Y'), reexport: true },
      {
        name: 'missing',
        origin: { kind: 'unresolved', reason: 'unresolved-binding', subject: 'pkg2.py:missing' },
        reexport: true,
      },
    ]);
  });
});

describe('name resolution', () => {
  it('follows a re-export chain through three modules to the declaration', () => {
    const resolver = symbols({
      'a/__init__.py': 'from .b import X\n',
      'a/b.py': 'from .c import X\n',
      'a/c.py': 'X = 1\n',
    });
    expect(resolver.resolveName('a/__init__.py', 'X')).toEqual(sym('a/c.py:X'));
  });

  it('resolves an import cycle as unresolved instead of looping', () => {
    const resolver = symbols({
      'c1.py': 'from c2 import Q\n',
      'c2.py': 'from c1 import Q\n',
    });
    expect(resolver.resolveName('c1.py', 'Q')).toEqual({
      kind: 'unresolved',
      reason: 'unresolved-binding',
      subject: 'c1.py:Q',
    });
  });

  it('reports a name the module neither declares nor imports as unresolved', () => {
    const resolver = symbols({ 'empty.py': 'x = 1\n' });
    expect(resolver.resolveName('empty.py', 'nothere')).toEqual({
      kind: 'unresolved',
      reason: 'unresolved-binding',
      subject: 'empty.py:nothere',
    });
  });
});
