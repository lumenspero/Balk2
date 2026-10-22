import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { createImportResolver } from './modules/import-resolution.js';
import { ModuleIndex } from './modules/module-index.js';
import { createSymbolResolver } from './modules/module-exports.js';
import {
  analyzeInheritance,
  type ClassInheritance,
  type InheritanceAnalysis,
} from './inheritance.js';

const FIXTURE = path.resolve(__dirname, '../../../test/fixtures/python-baseline');

/** Analyzes a repository given as a map of path to source. */
function run(files: Record<string, string>): InheritanceAnalysis {
  const index = new ModuleIndex(Object.keys(files));
  const readText = (p: string): string => files[p] ?? '';
  const imports = createImportResolver(index, { roots: ['.'], readText });
  const symbols = createSymbolResolver({ resolver: imports, readText });
  return analyzeInheritance(
    Object.entries(files).map(([filePath, source]) => ({ filePath, source })),
    { symbols, imports },
  );
}

function classOf(classes: readonly ClassInheritance[], id: string): ClassInheritance {
  const found = classes.find((c) => c.id === id);
  if (found === undefined) throw new Error(`no class ${id}`);
  return found;
}

describe('python inheritance: base resolution', () => {
  it('resolves a base defined in the same module', () => {
    const r = run({ 'm.py': 'class Base:\n    pass\nclass User(Base):\n    pass\n' });
    const user = classOf(r.classes, 'm.py:User');
    expect(user.bases.map((b) => b.target)).toEqual([{ kind: 'symbol', id: 'm.py:Base' }]);
    expect(user.mro).toEqual(['m.py:User', 'm.py:Base']);
  });

  it('resolves a base imported with from (the baseline extends edge)', () => {
    const r = run({
      'pipeline/util.py': 'class Base:\n    pass\n',
      'pipeline/models.py': 'from pipeline.util import Base\nclass User(Base):\n    pass\n',
    });
    expect(classOf(r.classes, 'pipeline/models.py:User').bases[0]?.target).toEqual({
      kind: 'symbol',
      id: 'pipeline/util.py:Base',
    });
  });

  it('resolves a base reached through a module attribute', () => {
    const r = run({
      'pipeline/util.py': 'class Base:\n    pass\n',
      'main.py': 'import pipeline.util as u\nclass User(u.Base):\n    pass\n',
    });
    expect(classOf(r.classes, 'main.py:User').bases[0]?.target).toEqual({
      kind: 'symbol',
      id: 'pipeline/util.py:Base',
    });
  });

  it('resolves Outer.Inner to the nested class', () => {
    const r = run({
      'm.py': 'class Outer:\n    class Inner:\n        pass\nclass Sub(Outer.Inner):\n    pass\n',
    });
    expect(classOf(r.classes, 'm.py:Sub').bases[0]?.target).toEqual({
      kind: 'symbol',
      id: 'm.py:Outer.Inner',
    });
  });

  it('resolves a nested class named from inside its enclosing class body', () => {
    const r = run({
      'm.py': 'class Outer:\n    class Inner:\n        pass\n    class Sub(Inner):\n        pass\n',
    });
    expect(classOf(r.classes, 'm.py:Outer.Sub').bases[0]?.target).toEqual({
      kind: 'symbol',
      id: 'm.py:Outer.Inner',
    });
  });

  it('reports an external base as external, with no repository target', () => {
    const r = run({ 'm.py': 'from requests import Session\nclass S(Session):\n    pass\n' });
    expect(classOf(r.classes, 'm.py:S').bases[0]?.target).toMatchObject({
      kind: 'external',
      name: 'requests',
    });
  });

  it('marks a base that a star import may supply as ambiguous (negative)', () => {
    const r = run({ 'm.py': 'from os import *\nclass X(Base):\n    pass\n' });
    expect(classOf(r.classes, 'm.py:X').bases[0]?.target).toEqual({
      kind: 'unresolved',
      reason: 'ambiguous-star-import',
      subject: 'Base',
    });
  });

  it('leaves a base nothing binds with no target', () => {
    const r = run({ 'm.py': 'class X(Missing):\n    pass\n' });
    expect(classOf(r.classes, 'm.py:X').bases[0]?.target).toBeUndefined();
  });
});

describe('python inheritance: method resolution order', () => {
  it('linearizes a diamond with C3', () => {
    const r = run({
      'm.py':
        'class A:\n    pass\nclass B(A):\n    pass\nclass C(A):\n    pass\nclass D(B, C):\n    pass\n',
    });
    expect(classOf(r.classes, 'm.py:D').mro).toEqual(['m.py:D', 'm.py:B', 'm.py:C', 'm.py:A']);
    expect(r.problems).toEqual([]);
  });

  it('reports an inconsistent order and leaves the MRO empty', () => {
    const r = run({
      'm.py': 'class X:\n    pass\nclass Y(X):\n    pass\nclass Z(X, Y):\n    pass\n',
    });
    expect(classOf(r.classes, 'm.py:Z').mro).toBeNull();
    expect(r.problems.map((p) => p.message)).toEqual([
      'no consistent method resolution order for m.py:Z',
    ]);
  });

  it('reports an inheritance cycle instead of looping', () => {
    const r = run({ 'm.py': 'class A(B):\n    pass\nclass B(A):\n    pass\n' });
    expect(classOf(r.classes, 'm.py:A').mro).toBeNull();
    expect(r.problems.some((p) => p.message.startsWith('inheritance cycle'))).toBe(true);
  });
});

describe('python inheritance: abstract classes and registration', () => {
  it('marks a subclass of abc.ABC abstract, and so its subclasses', () => {
    const r = run({
      'm.py':
        'from abc import ABC\nclass Shape(ABC):\n    pass\nclass Square(Shape):\n    pass\nclass Plain:\n    pass\n',
    });
    expect(classOf(r.classes, 'm.py:Shape').abstract).toBe(true);
    expect(classOf(r.classes, 'm.py:Square').abstract).toBe(true);
    expect(classOf(r.classes, 'm.py:Plain').abstract).toBe(false);
  });

  it('marks a typing.Protocol subclass abstract through the module attribute', () => {
    const r = run({ 'm.py': 'import typing\nclass P(typing.Protocol):\n    pass\n' });
    expect(classOf(r.classes, 'm.py:P').abstract).toBe(true);
  });

  it('reads metaclass=ABCMeta as abstract, and does not count it as a base', () => {
    const r = run({ 'm.py': 'from abc import ABCMeta\nclass M(metaclass=ABCMeta):\n    pass\n' });
    const m = classOf(r.classes, 'm.py:M');
    expect(m.abstract).toBe(true);
    expect(m.bases).toEqual([]);
  });

  it('records ABC.register(Cls) as an implementation of the repository ABC', () => {
    const r = run({
      'm.py':
        'from abc import ABC\nclass Shape(ABC):\n    pass\nclass Circle:\n    pass\nShape.register(Circle)\n',
    });
    expect(r.implementations.map((i) => [i.classId, i.abcId])).toEqual([
      ['m.py:Circle', 'm.py:Shape'],
    ]);
  });

  it('ignores register calls whose receiver is not a repository class (negative)', () => {
    const r = run({
      'm.py': 'from abc import ABC\nclass Circle:\n    pass\nABC.register(Circle)\n',
    });
    expect(r.implementations).toEqual([]);
  });
});

describe('python inheritance: baseline floor', () => {
  it('keeps the baseline extends edge from pipeline/models.py:User to pipeline/util.py:Base', () => {
    const names = ['app.py', 'pipeline/models.py', 'pipeline/util.py', 'pipeline/normalize.py'];
    const files: Record<string, string> = {};
    for (const name of names) files[name] = fs.readFileSync(path.join(FIXTURE, name), 'utf8');
    const user = classOf(run(files).classes, 'pipeline/models.py:User');
    expect(user.bases.map((b) => b.target)).toEqual([
      { kind: 'symbol', id: 'pipeline/util.py:Base' },
    ]);
  });
});
