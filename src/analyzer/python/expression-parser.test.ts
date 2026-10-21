import { describe, expect, it } from 'vitest';
import { formatExpr } from './expression-format.js';
import { parseExpressionSource } from './expression-parser.js';
import { PythonSyntaxError } from './cursor.js';

const cases: ReadonlyArray<readonly [string, string]> = [
  ['1 + 2 * 3', '(+ 1 (* 2 3))'],
  ['-2 ** 3', '(- (** 2 3))'],
  ['2 ** -1', '(** 2 (- 1))'],
  ['a - b - c', '(- (- a b) c)'],
  ['a < b < c', '(cmp a < b < c)'],
  ['a is not None', '(cmp a is not None)'],
  ['a not in b', '(cmp a not in b)'],
  ['not a and b or c', '(or (and (not a) b) c)'],
  ['a if b else c if d else e', '(if b a (if d c e))'],
  ['await f(x)', '(await (call f x))'],
  ['f(a, k=1, *r, **kw).x[0]', '([] (. (call f a k=1 *r **kw) x) 0)'],
  ['a[1:2, ::3]', '([] a (tuple (slice 1 2 -) (slice - - 3)))'],
  ['x[::]', '([] x (slice - - -))'],
  ['lambda x, y=1: x + y', '(lambda (x y=1) (+ x y))'],
  ['[x * 2 for x in xs if x > 0]', '(listcomp (* x 2) for x in xs if (cmp x > 0))'],
  ['[a if b else c for d in e]', '(listcomp (if b a c) for d in e)'],
  ['f(x for x in y)', '(call f (generatorcomp x for x in y))'],
  ['{k: v for k, v in d.items()}', '(dictcomp k : v for (tuple k v) in (call (. d items)))'],
  ['(y := f(x))', '(:= y (call f x))'],
  ['(a)', 'a'],
  ['(a,)', '(tuple a)'],
  ['()', '(tuple )'],
  ['1, 2', '(tuple 1 2)'],
  ['[*a, b]', '(list (* a) b)'],
  ['[]', '(list )'],
  ['{}', '(dict )'],
  ['{1, 2}', '(set 1 2)'],
  ["{**a, 'k': v}", "(dict **a 'k':v)"],
  ['"a" "b"', '"a" "b"'],
  ['f"a{x!r:>{w}}"', '(f a{x!r:>{w}})'],
  ['f"{x=}"', '(f {x=})'],
  ['"a" f"b{c}"', '(f "a"b{c})'],
  ['f"{d["a"]}"', '(f {([] d "a")})'],
];

describe('python expression parser: shape', () => {
  for (const [source, expected] of cases) {
    it(`parses ${source}`, () => {
      expect(formatExpr(parseExpressionSource(source))).toBe(expected);
    });
  }
});

describe('python expression parser: syntax errors', () => {
  it.each(['1 +', 'f(', 'a.', '(1, 2', '[1 2]', '"a" b"c"'])('rejects %s', (source) => {
    expect(() => parseExpressionSource(source)).toThrow(PythonSyntaxError);
  });
});

describe('python expression parser: spans', () => {
  it('spans an attribute from its first token to its last', () => {
    expect(parseExpressionSource('a.b')).toMatchObject({
      kind: 'attribute',
      span: { line: 1, column: 1, endLine: 1, endColumn: 4 },
    });
  });
});
