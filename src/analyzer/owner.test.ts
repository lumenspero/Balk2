import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { enclosingOwner, ownerOf } from './owner.js';

/** The enclosing owner of every `probe()` call in `code`, in source order. */
function ownersOfProbes(code: string): string[] {
  const sourceFile = ts.createSourceFile('src/a.ts', code, ts.ScriptTarget.ES2022, true);
  const owners: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'probe'
    ) {
      owners.push(enclosingOwner(node, 'src/a.ts'));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return owners;
}

describe('enclosingOwner', () => {
  it('names a function, a method, a class member initializer and a function-valued variable', () => {
    expect(
      ownersOfProbes(
        [
          'function build() { probe(); }',
          'class Svc {',
          '  run() { probe(); }',
          '  field = probe();',
          '}',
          'const handler = () => { probe(); };',
          'const expression = function () { probe(); };',
        ].join('\n'),
      ),
    ).toEqual([
      'src/a.ts:build',
      'src/a.ts:Svc.run',
      'src/a.ts:Svc',
      'src/a.ts:handler',
      'src/a.ts:expression',
    ]);
  });

  it('uses the file for top-level code and for callbacks passed at the top level', () => {
    expect(
      ownersOfProbes('probe();\nsetTimeout(() => probe(), 0);\nconst x = [1].map(() => probe());'),
    ).toEqual(['src/a.ts', 'src/a.ts', 'src/a.ts']);
  });

  it('prefers the nearest owner when owners are nested', () => {
    expect(
      ownersOfProbes(
        'function outer() { const inner = () => { probe(); }; probe(); function nested() { probe(); } }',
      ),
    ).toEqual(['src/a.ts:inner', 'src/a.ts:outer', 'src/a.ts:nested']);
  });

  it('uses the file for methods of an anonymous class, which has no owner name', () => {
    expect(ownersOfProbes('export default class { run() { probe(); } }')).toEqual(['src/a.ts']);
  });

  it('names methods of an object literal by its variable, and anonymous ones by source order', () => {
    expect(ownersOfProbes('const api = { load() { probe(); } };')).toEqual(['src/a.ts:api.load']);
    expect(
      ownersOfProbes('export default { load() { probe(); } };\nconst b = { run() { probe(); } };'),
    ).toEqual(['src/a.ts:<anonymous>#1.load', 'src/a.ts:b.run']);
  });

  it('qualifies a class declared inside a method with the outer class (D6)', () => {
    expect(ownersOfProbes('class Outer { run() { class Inner { go() { probe(); } } } }')).toEqual([
      'src/a.ts:Outer.Inner.go',
    ]);
  });

  it('attributes a callback inside a method to that method', () => {
    expect(ownersOfProbes('class A { go() { setTimeout(() => probe(), 0); } }')).toEqual([
      'src/a.ts:A.go',
    ]);
  });
});

describe('ownerOf', () => {
  const owner = (code: string): string | undefined => {
    const sourceFile = ts.createSourceFile('src/a.ts', code, ts.ScriptTarget.ES2022, true);
    const [statement] = sourceFile.statements;
    if (!statement) return undefined;
    const node = ts.isVariableStatement(statement)
      ? statement.declarationList.declarations[0]
      : statement;
    return node ? ownerOf(node, 'src/a.ts') : undefined;
  };

  it('identifies named owners', () => {
    expect(owner('function f() {}')).toBe('src/a.ts:f');
    expect(owner('class C {}')).toBe('src/a.ts:C');
    expect(owner('const g = () => 1;')).toBe('src/a.ts:g');
  });

  it('ignores nodes that start no owner', () => {
    expect(owner('const plain = 1;')).toBeUndefined();
    expect(owner('const call = make();')).toBeUndefined();
    expect(owner('export default function () {}')).toBeUndefined();
  });
});
