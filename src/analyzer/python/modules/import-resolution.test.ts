import { describe, expect, it } from 'vitest';
import { createImportResolver, type ResolvedImport } from './import-resolution.js';
import { ModuleIndex } from './module-index.js';

/** Resolve one file in a repository given as a map of path to source. */
function resolve(
  files: Record<string, string>,
  target: string,
  options: { roots?: string[]; scriptDir?: string } = {},
): ResolvedImport[] {
  const index = new ModuleIndex(Object.keys(files));
  const resolver = createImportResolver(index, {
    roots: options.roots ?? ['.'],
    readText: (path) => files[path] ?? '',
  });
  return resolver.resolveFile(target, files[target] ?? '', { scriptDir: options.scriptDir });
}

const pkg = {
  'pkg/__init__.py': 'x = 1\n',
  'pkg/mod.py': 'y = 2\n',
};

describe('absolute imports', () => {
  it('resolves a dotted import and binds the alias', () => {
    const [edge] = resolve({ ...pkg, 'main.py': 'import pkg.mod as m\n' }, 'main.py');
    expect(edge).toMatchObject({
      specifier: 'pkg.mod',
      form: 'import',
      via: 'whole',
      target: { kind: 'file', path: 'pkg/mod.py' },
      names: ['m'],
      typeOnly: false,
    });
  });

  it('binds the top-level name for a plain dotted import', () => {
    const [edge] = resolve({ ...pkg, 'main.py': 'import pkg.mod\n' }, 'main.py');
    expect(edge?.names).toEqual(['pkg']);
  });

  it('reports an internal name that matches nothing as unresolved, and an outside name as external', () => {
    const results = resolve(
      { ...pkg, 'main.py': 'import pkg.nothere\nimport requests\n' },
      'main.py',
    );
    expect(results[0]?.target).toEqual({
      kind: 'unresolved',
      reason: 'unresolved-module-path',
      subject: 'pkg.nothere',
    });
    expect(results[1]?.target).toEqual({ kind: 'external', name: 'requests' });
  });

  it('prefers a package in an earlier root', () => {
    const [edge] = resolve(
      { 'src/pkg/a.py': '', 'pkg/a.py': '', 'main.py': 'import pkg.a\n' },
      'main.py',
      { roots: ['src', '.'] },
    );
    expect(edge?.target).toEqual({ kind: 'file', path: 'src/pkg/a.py' });
  });

  it('resolves a stub-only module to its .pyi file', () => {
    const [edge] = resolve({ 'stubby.pyi': '', 'main.py': 'import stubby\n' }, 'main.py');
    expect(edge?.target).toEqual({ kind: 'file', path: 'stubby.pyi' });
  });

  it('resolves a namespace package segment and gives no edge for the namespace alone', () => {
    const results = resolve(
      { 'ns/mod.py': 'v = 1\n', 'main.py': 'import ns.mod\nimport ns\n' },
      'main.py',
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.target).toEqual({ kind: 'file', path: 'ns/mod.py' });
  });

  it('searches the script directory before the roots, for a script', () => {
    const files = { 'scripts/helper.py': '', 'scripts/run.py': 'import helper\n' };
    expect(resolve(files, 'scripts/run.py')[0]?.target).toEqual({
      kind: 'external',
      name: 'helper',
    });
    expect(resolve(files, 'scripts/run.py', { scriptDir: 'scripts' })[0]?.target).toEqual({
      kind: 'file',
      path: 'scripts/helper.py',
    });
  });
});

describe('from imports and relative imports', () => {
  it('treats a name the package binds as an attribute, with no submodule edge', () => {
    const results = resolve({ ...pkg, 'main.py': 'from pkg import x\n' }, 'main.py');
    expect(results).toEqual([
      expect.objectContaining({
        via: 'attribute',
        target: { kind: 'file', path: 'pkg/__init__.py' },
        names: ['x'],
      }),
    ]);
  });

  it('prefers an attribute over a submodule of the same name', () => {
    const results = resolve(
      { 'pkg/__init__.py': 'mod = 1\n', 'pkg/mod.py': '', 'main.py': 'from pkg import mod\n' },
      'main.py',
    );
    expect(results.map((r) => r.via)).toEqual(['attribute']);
  });

  it('resolves a name that is a submodule, and keeps the package init as its own edge', () => {
    const results = resolve({ ...pkg, 'main.py': 'from pkg import mod\n' }, 'main.py');
    expect(results).toEqual([
      expect.objectContaining({
        via: 'whole',
        target: { kind: 'file', path: 'pkg/__init__.py' },
        names: [],
      }),
      expect.objectContaining({
        via: 'submodule',
        target: { kind: 'file', path: 'pkg/mod.py' },
        names: ['mod'],
      }),
    ]);
  });

  it('reports a name that matches neither an attribute nor a submodule as an unresolved binding', () => {
    const results = resolve({ ...pkg, 'main.py': 'from pkg import nothere\n' }, 'main.py');
    expect(results.at(-1)).toMatchObject({
      via: 'unresolved',
      target: { kind: 'unresolved', reason: 'unresolved-binding', subject: 'pkg.nothere' },
      names: ['nothere'],
    });
  });

  it('resolves relative levels from the file package', () => {
    const files = {
      'pkg/__init__.py': '',
      'pkg/b.py': 'c = 1\n',
      'pkg/a.py': 'from . import b\nfrom .b import c\n',
    };
    const results = resolve(files, 'pkg/a.py');
    expect(results).toEqual([
      expect.objectContaining({
        specifier: '.',
        via: 'whole',
        target: { kind: 'file', path: 'pkg/__init__.py' },
      }),
      expect.objectContaining({
        specifier: '.',
        via: 'submodule',
        target: { kind: 'file', path: 'pkg/b.py' },
        names: ['b'],
      }),
      expect.objectContaining({
        specifier: '.b',
        via: 'attribute',
        target: { kind: 'file', path: 'pkg/b.py' },
        names: ['c'],
      }),
    ]);
  });

  it('climbs one package per extra dot', () => {
    const files = {
      'pkg/__init__.py': '',
      'pkg/top.py': 'v = 1\n',
      'pkg/sub/__init__.py': '',
      'pkg/sub/a.py': 'from ..top import v\n',
    };
    const [edge] = resolve(files, 'pkg/sub/a.py');
    expect(edge).toMatchObject({
      specifier: '..top',
      via: 'attribute',
      target: { kind: 'file', path: 'pkg/top.py' },
    });
  });

  it('reports a relative import that climbs past the top level as unresolved', () => {
    const [edge] = resolve({ 'top.py': 'from .. import x\n' }, 'top.py');
    expect(edge).toMatchObject({
      via: 'unresolved',
      target: { kind: 'unresolved', reason: 'unresolved-module-path', subject: '..' },
    });
  });
});

describe('conditions', () => {
  it('marks TYPE_CHECKING imports as type-only and labels the else branch', () => {
    const source = [
      'from typing import TYPE_CHECKING',
      'if TYPE_CHECKING:',
      '    from pkg import mod',
      'else:',
      '    import pkg.mod',
      '',
    ].join('\n');
    const results = resolve({ ...pkg, 'pkg/mod.py': '', 'main.py': source }, 'main.py');
    const typed = results.find((r) => r.specifier === 'pkg');
    const runtime = results.find((r) => r.specifier === 'pkg.mod');
    expect(typed).toMatchObject({ typeOnly: true, condition: 'TYPE_CHECKING' });
    expect(runtime).toMatchObject({ typeOnly: false, condition: 'not TYPE_CHECKING' });
  });

  it('labels try and except alternatives', () => {
    const source = [
      'try:',
      '    import ujson as json',
      'except ImportError:',
      '    import json',
      '',
    ].join('\n');
    const results = resolve({ 'main.py': source }, 'main.py');
    expect(results).toEqual([
      expect.objectContaining({
        specifier: 'ujson',
        condition: 'try',
        target: { kind: 'external', name: 'ujson' },
      }),
      expect.objectContaining({
        specifier: 'json',
        condition: 'except ImportError',
        target: { kind: 'external', name: 'json' },
      }),
    ]);
  });
});

describe('star imports', () => {
  it('uses a static __all__ when the module has one', () => {
    const [edge] = resolve(
      {
        'star.py': '__all__ = ["a", "b"]\na = 1\nb = 2\nc = 3\n',
        'main.py': 'from star import *\n',
      },
      'main.py',
    );
    expect(edge).toMatchObject({
      via: 'star',
      names: ['a', 'b'],
      target: { kind: 'file', path: 'star.py' },
    });
  });

  it('uses the public names when there is no static __all__', () => {
    const [edge] = resolve(
      {
        'star.py': '_hidden = 0\nvisible = 1\n__all__ = build()\n',
        'main.py': 'from star import *\n',
      },
      'main.py',
    );
    expect(edge?.names).toEqual(['visible']);
  });
});
