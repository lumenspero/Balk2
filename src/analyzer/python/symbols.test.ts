import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Declaration } from '../../facts/types.js';
import { parseModuleRecovering } from './statement-parser.js';
import { analyzePythonSymbols, groupSymbols } from './symbols.js';

const FIXTURE = path.resolve(__dirname, '../../../test/fixtures/python-baseline');
const SNAPSHOT = path.resolve(__dirname, '../../../test/snapshots/python-baseline.txt');
const FIXTURE_FILES = [
  'app.py',
  'broken.py',
  'pipeline/__init__.py',
  'pipeline/models.py',
  'pipeline/normalize.py',
  'pipeline/util.py',
  'scripts/collect.py',
];

/**
 * Symbols the Phase 0.8 baseline has that V3 does not declare, each with its reason. Recorded here
 * and in docs/v3/python-changes.md when Phase 5 completes.
 */
const KNOWN_FALSE_POSITIVES: ReadonlySet<string> = new Set([
  // `def broken(:` is not valid Python. The regex analyzer invented the symbol from it.
  'broken.py:broken',
]);

function declare(source: string, file = 'm.py'): Declaration[] {
  return analyzePythonSymbols(source, file).declarations.slice();
}

function find(decls: readonly Declaration[], name: string): Declaration {
  const found = decls.find((d) => d.name === name);
  if (found === undefined) throw new Error(`no declaration named ${name}`);
  return found;
}

function legacySymbols(): string[] {
  const lines = fs.readFileSync(SNAPSHOT, 'utf8').split('\n');
  const start = lines.indexOf('# nodes: symbols');
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line.startsWith('#')) break;
    if (line !== '') out.push(line);
  }
  return out;
}

describe('python symbols: classes, functions and methods', () => {
  it('declares classes, module functions and methods with the shared ids', () => {
    const src = 'class User:\n    def save(self):\n        pass\n\ndef helper(v):\n    return v\n';
    const decls = declare(src);
    expect(decls.map((d) => d.id)).toEqual(['m.py:User', 'm.py:User.save', 'm.py:helper']);
    expect(find(decls, 'User').symbolType).toBe('class');
    expect(find(decls, 'save').symbolType).toBe('method');
    expect(find(decls, 'save').owner).toBe('m.py:User');
    expect(find(decls, 'helper').symbolType).toBe('function');
    expect(find(decls, 'helper').owner).toBeNull();
  });

  it('qualifies nested classes and their methods as Outer.Inner', () => {
    const decls = declare(
      'class Outer:\n    class Inner:\n        def m(self):\n            pass\n',
    );
    expect(decls.map((d) => d.id)).toEqual([
      'm.py:Outer',
      'm.py:Outer.Inner',
      'm.py:Outer.Inner.m',
    ]);
    expect(find(decls, 'Inner').owner).toBe('m.py:Outer');
    expect(find(decls, 'm').owner).toBe('m.py:Outer.Inner');
  });

  it('treats staticmethod, classmethod and property methods as methods', () => {
    const src =
      'class C:\n    @staticmethod\n    def s():\n        pass\n    @classmethod\n    def c(cls):\n        pass\n    @property\n    def p(self):\n        return 1\n';
    expect(declare(src).map((d) => d.symbolType)).toEqual(['class', 'method', 'method', 'method']);
  });

  it('declares a function nested in a function, owned by the outer function', () => {
    const inner = find(declare('def outer():\n    def inner():\n        pass\n'), 'inner');
    expect(inner.id).toBe('m.py:inner');
    expect(inner.owner).toBe('m.py:outer');
    expect(inner.exported).toBe(false);
  });

  it('declares a PEP 695 type alias as a type', () => {
    const [alias] = declare('type Pair[T] = tuple[T, T]\n');
    expect(alias).toMatchObject({ id: 'm.py:Pair', symbolType: 'type' });
  });
});

describe('python symbols: module-level names', () => {
  it('classes UPPER_CASE and Final names as constants, and other names as variables', () => {
    const decls = declare('MAX = 1\ncount = 0\n_LIMIT = 2\nTIMEOUT: Final = 3\n');
    expect(find(decls, 'MAX').symbolType).toBe('constant');
    expect(find(decls, 'count').symbolType).toBe('variable');
    expect(find(decls, '_LIMIT')).toMatchObject({ symbolType: 'constant', visibility: 'private' });
    expect(find(decls, 'TIMEOUT').symbolType).toBe('constant');
  });

  it('declares every name in a tuple target', () => {
    const decls = declare('A, (b, *c) = 1, (2, [3])\n');
    expect(decls.map((d) => [d.name, d.symbolType])).toEqual([
      ['A', 'constant'],
      ['b', 'variable'],
      ['c', 'variable'],
    ]);
  });

  it('does not declare names assigned inside functions or class bodies', () => {
    expect(declare('def f():\n    LOCAL = 1\n    x = 2\n').map((d) => d.id)).toEqual(['m.py:f']);
    expect(declare('class C:\n    K = 1\n').map((d) => d.id)).toEqual(['m.py:C']);
  });

  it('marks __all__ names as exported and leaves other public names unexported', () => {
    const decls = declare('import x\n__all__ = ["pub"]\ndef pub(): pass\ndef other(): pass\n');
    expect(find(decls, 'pub').exported).toBe(true);
    expect(find(decls, 'other').exported).toBe(false);
  });

  it('marks public names as exported when there is no static __all__', () => {
    const decls = declare('def pub(): pass\ndef _hidden(): pass\n');
    expect(find(decls, 'pub')).toMatchObject({ exported: true, visibility: 'public' });
    expect(find(decls, '_hidden')).toMatchObject({ exported: false, visibility: 'private' });
  });
});

describe('python symbols: conditional definitions', () => {
  it('records each enclosing condition, and groups twin definitions under one id', () => {
    const decls = declare('if TYPE_CHECKING:\n    X = 1\nelse:\n    X = 2\n');
    const group = groupSymbols(decls).get('m.py:X') ?? [];
    expect(group.map((d) => d.condition)).toEqual(['TYPE_CHECKING', 'not (TYPE_CHECKING)']);
  });

  it('treats a try/except ImportError fallback definition as a twin', () => {
    const src = 'try:\n    def f(): pass\nexcept ImportError:\n    def f(): pass\n';
    const group = groupSymbols(declare(src)).get('m.py:f') ?? [];
    expect(group.map((d) => d.condition)).toEqual(['try', 'except ImportError']);
  });
});

describe('python symbols: dataclass and NamedTuple fields', () => {
  it('declares dataclass fields as variables owned by the class, with their annotations', () => {
    const src =
      'from dataclasses import dataclass\n@dataclass\nclass User:\n    name: str\n    tags: list[str] = []\n';
    const analysis = analyzePythonSymbols(src, 'm.py');
    const name = analysis.declarations.find((d) => d.id === 'm.py:User.name');
    expect(name).toMatchObject({ symbolType: 'variable', owner: 'm.py:User' });
    expect(analysis.fieldAnnotations.map((f) => f.owner)).toEqual([
      'm.py:User.name',
      'm.py:User.tags',
    ]);
    expect(analysis.fieldAnnotations[0]?.annotation.kind).toBe('name');
  });

  it('declares NamedTuple fields and ignores annotations on an ordinary class', () => {
    expect(
      analyzePythonSymbols('class P(NamedTuple):\n    x: int\n', 'm.py').declarations.map(
        (d) => d.id,
      ),
    ).toEqual(['m.py:P', 'm.py:P.x']);
    const plain = analyzePythonSymbols('class Plain:\n    x: int\n', 'm.py');
    expect(plain.declarations.map((d) => d.id)).toEqual(['m.py:Plain']);
    expect(plain.fieldAnnotations).toEqual([]);
  });
});

describe('python symbols: baseline floor', () => {
  it('declares every Phase 0.8 baseline symbol, except the documented false positives', () => {
    const produced = new Set<string>();
    for (const rel of FIXTURE_FILES) {
      const source = fs.readFileSync(path.join(FIXTURE, rel), 'utf8');
      for (const d of analyzePythonSymbols(source, rel).declarations) produced.add(d.id);
    }
    const missing = legacySymbols().filter(
      (id) => !produced.has(id) && !KNOWN_FALSE_POSITIVES.has(id),
    );
    expect(missing).toEqual([]);
  });

  it('does not declare the broken baseline file, which has a syntax error', () => {
    const source = fs.readFileSync(path.join(FIXTURE, 'broken.py'), 'utf8');
    expect(parseModuleRecovering(source).errors.length).toBeGreaterThan(0);
    expect(analyzePythonSymbols(source, 'broken.py').declarations).toEqual([]);
  });
});
