import { describe, expect, it } from 'vitest';
import type { Stmt } from './ast.js';
import { parseModuleRecovering } from './statement-parser.js';
import { pythonSyntaxNotes } from './syntax-notes.js';

const kinds = (stmts: readonly Stmt[]): string[] => stmts.map((s) => s.kind);

describe('python parser recovery: statement boundaries', () => {
  it('keeps the statement after a broken line', () => {
    const { body, errors } = parseModuleRecovering('a = 1 +\nb = 2\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 1 });
    expect(body).toMatchObject([{ kind: 'assign', targets: [{ id: 'b' }] }]);
  });

  it('reports each broken line and keeps the good ones', () => {
    const { body, errors } = parseModuleRecovering('x = 1 +\ny = 2 +\nz = 3\n');
    expect(errors.map((e) => e.line)).toEqual([1, 2]);
    expect(body).toMatchObject([{ kind: 'assign', targets: [{ id: 'z' }] }]);
  });
});

describe('python parser recovery: blocks', () => {
  it('keeps the siblings of a broken statement inside a block', () => {
    const { body, errors } = parseModuleRecovering('def f():\n    x = = 1\n    y = 2\nz = 3\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ line: 2 });
    expect(body.map((s) => s.kind)).toEqual(['funcdef', 'assign']);
    const [fn] = body;
    if (fn?.kind !== 'funcdef') throw new Error('expected a function');
    expect(kinds(fn.body)).toEqual(['assign']);
  });

  it('skips the indented block of a broken header', () => {
    const { body, errors } = parseModuleRecovering('if x\n    pass\ny = 1\n');
    expect(errors).toHaveLength(1);
    expect(body).toMatchObject([{ kind: 'assign', targets: [{ id: 'y' }] }]);
  });

  it('skips a stray indent', () => {
    const { body, errors } = parseModuleRecovering('  x = 1\ny = 2\n');
    expect(errors).toHaveLength(1);
    expect(body).toMatchObject([{ kind: 'assign', targets: [{ id: 'y' }] }]);
  });
});

describe('python parser recovery: notes', () => {
  it('reports a tokenizer error once, even when the parser fails at the same place', () => {
    const { body, errors } = parseModuleRecovering('x = "abc\ny = 1\n');
    expect(errors).toHaveLength(1);
    expect(body).toMatchObject([{ kind: 'assign', targets: [{ id: 'y' }] }]);
  });

  it('reports nothing for a clean file', () => {
    expect(parseModuleRecovering('x = 1\n').errors).toHaveLength(0);
  });
});

describe('python parser recovery: never throws', () => {
  it('returns notes for every prefix of a program', () => {
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
      'z = 1 +',
      '',
    ].join('\n');
    for (let i = 0; i <= program.length; i += 1) {
      expect(() => parseModuleRecovering(program.slice(0, i))).not.toThrow();
    }
  });
});

describe('python syntax notes', () => {
  it('reports parse problems with the file path', () => {
    expect(pythonSyntaxNotes('pkg/bad.py', 'x = 1 +\n')).toMatchObject([
      { path: 'pkg/bad.py', line: 1 },
    ]);
  });

  it('reports nothing for a clean file', () => {
    expect(pythonSyntaxNotes('pkg/ok.py', 'x = 1\n')).toHaveLength(0);
  });
});
