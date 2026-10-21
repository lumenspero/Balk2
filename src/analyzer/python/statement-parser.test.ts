import { describe, expect, it } from 'vitest';
import { PythonSyntaxError } from './cursor.js';
import { parseModule } from './statement-parser.js';
import type { Stmt } from './ast.js';

const kinds = (stmts: readonly Stmt[]): string[] => stmts.map((s) => s.kind);

describe('python statement parser: simple statements', () => {
  it('parses assignments, augmented and annotated assignments', () => {
    expect(kinds(parseModule('x = 1\ny += 2\nz: int = 3\n'))).toEqual([
      'assign',
      'augassign',
      'annassign',
    ]);
  });

  it('keeps every target of a chained assignment', () => {
    const [stmt] = parseModule('a = b = c\n');
    expect(stmt).toMatchObject({ kind: 'assign', targets: [{ kind: 'name' }, { kind: 'name' }] });
  });

  it('splits semicolon-separated statements', () => {
    expect(kinds(parseModule('pass; break\n'))).toEqual(['pass', 'break']);
  });

  it('parses import forms', () => {
    const [plain] = parseModule('import a.b as c, d\n');
    expect(plain).toMatchObject({
      kind: 'import',
      names: [
        { name: 'a.b', asname: 'c' },
        { name: 'd', asname: null },
      ],
    });
    const [relative] = parseModule('from ..pkg import (a as b, c,)\n');
    expect(relative).toMatchObject({ kind: 'importfrom', module: 'pkg', level: 2 });
    const [star] = parseModule('from . import *\n');
    expect(star).toMatchObject({ kind: 'importfrom', module: null, level: 1, names: 'star' });
  });

  it('parses global, del, assert and raise', () => {
    expect(kinds(parseModule('global a, b\ndel x\nassert y, "m"\nraise E from e\n'))).toEqual([
      'global',
      'delete',
      'assert',
      'raise',
    ]);
  });
});

describe('python statement parser: compound statements', () => {
  it('nests elif as the else branch', () => {
    const [stmt] = parseModule('if a:\n    pass\nelif b:\n    pass\nelse:\n    pass\n');
    expect(stmt).toMatchObject({
      kind: 'if',
      orelse: [{ kind: 'if', orelse: [{ kind: 'pass' }] }],
    });
  });

  it('parses a decorated async function with keyword-only parameters', () => {
    const [stmt] = parseModule('@dec\nasync def f(a, *, b=1, **kw) -> int:\n    return a\n');
    expect(stmt).toMatchObject({
      kind: 'funcdef',
      name: 'f',
      isAsync: true,
      decorators: [{ kind: 'name' }],
    });
    if (stmt?.kind !== 'funcdef') throw new Error('expected a function');
    expect(stmt.params.map((p) => p.kind)).toEqual(['normal', 'bare-star', 'normal', 'kwarg']);
    expect(stmt.returns).not.toBeNull();
  });

  it('parses a class with bases and a keyword argument', () => {
    const [stmt] = parseModule('class C(Base, metaclass=M):\n    x = 1\n');
    expect(stmt).toMatchObject({
      kind: 'classdef',
      name: 'C',
      bases: [{ kind: 'positional' }, { kind: 'keyword' }],
    });
  });

  it('parses loops with else clauses', () => {
    const [stmt] = parseModule('for i in range(3):\n    pass\nelse:\n    pass\n');
    expect(stmt).toMatchObject({ kind: 'for', orelse: [{ kind: 'pass' }] });
    expect(kinds(parseModule('while x:\n    break\n'))).toEqual(['while']);
  });

  it('parses parenthesized and plain with items', () => {
    const [paren] = parseModule('with (open(a) as f, open(b) as g):\n    pass\n');
    expect(paren).toMatchObject({
      kind: 'with',
      items: [{ target: { kind: 'name' } }, { target: { kind: 'name' } }],
    });
    const [plain] = parseModule('with a as b, c:\n    pass\n');
    expect(plain).toMatchObject({
      kind: 'with',
      items: [{ target: { kind: 'name' } }, { target: null }],
    });
    const [asGroup] = parseModule('with (a) as b:\n    pass\n');
    expect(asGroup).toMatchObject({ kind: 'with', items: [{ target: { kind: 'name' } }] });
  });

  it('parses try with except*, else and finally', () => {
    const [stmt] = parseModule(
      'try:\n    pass\nexcept* ValueError as e:\n    pass\nelse:\n    pass\nfinally:\n    pass\n',
    );
    expect(stmt).toMatchObject({
      kind: 'try',
      handlers: [{ isStar: true, name: 'e' }],
      orelse: [{ kind: 'pass' }],
      finalbody: [{ kind: 'pass' }],
    });
  });

  it('parses a generic function and a type alias', () => {
    const [fn] = parseModule('def f[T: int, *Ts, **P](x: T) -> T:\n    return x\n');
    if (fn?.kind !== 'funcdef') throw new Error('expected a function');
    expect(fn.typeParams.map((p) => p.kind)).toEqual(['typevar', 'typevartuple', 'paramspec']);
    expect(fn.typeParams[0]?.bound).not.toBeNull();
    const [alias] = parseModule('type Pair[T] = tuple[T, T]\n');
    expect(alias).toMatchObject({ kind: 'typealias', name: 'Pair' });
  });
});

describe('python statement parser: match statements', () => {
  it('parses the pattern forms', () => {
    const source = [
      'match point:',
      '    case (0, 0):',
      '        pass',
      '    case Point(x=0, y=yy) if yy > 0:',
      '        pass',
      '    case [1, *rest] | {"k": v, **kw}:',
      '        pass',
      '    case _:',
      '        pass',
      '',
    ].join('\n');
    const [stmt] = parseModule(source);
    if (stmt?.kind !== 'match') throw new Error('expected a match statement');
    expect(stmt.cases.map((c) => c.pattern.kind)).toEqual(['sequence', 'class', 'or', 'wildcard']);
    expect(stmt.cases[1]?.guard).not.toBeNull();
  });

  it('treats match as an ordinary name when it is not a match statement', () => {
    expect(kinds(parseModule('match = 1\nmatch(x)\n'))).toEqual(['assign', 'expr']);
  });
});

describe('python statement parser: syntax errors', () => {
  it.each([
    'def f(:\n    pass\n',
    'if x\n    pass\n',
    '  x = 1\n',
    '1 = x\n',
    'x = 1 +\n',
    'try:\n    pass\n',
  ])('rejects %s', (source) => {
    expect(() => parseModule(source)).toThrow(PythonSyntaxError);
  });
});

describe('python statement parser: robustness', () => {
  it('either parses or throws PythonSyntaxError for every prefix of a program', () => {
    const program = [
      '@dec',
      'def f(a, *, b=1) -> int:',
      '    if a:',
      '        return f"{a!r}"',
      '    elif b:',
      '        pass',
      'class C(B):',
      '    x = [i for i in range(3)]',
      'match v:',
      '    case [1, *r]:',
      '        pass',
      '',
    ].join('\n');
    for (let i = 0; i <= program.length; i += 1) {
      try {
        parseModule(program.slice(0, i));
      } catch (error) {
        expect(error).toBeInstanceOf(PythonSyntaxError);
      }
    }
  });
});
