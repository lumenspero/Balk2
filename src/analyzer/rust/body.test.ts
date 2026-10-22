import { describe, expect, it } from 'vitest';
import { parseRustFile } from './items.js';
import { scanFunctionBody, type BodyFact } from './body.js';

/** Scans the body of the first function in `source`. */
function facts(source: string): BodyFact[] {
  const item = parseRustFile(source).items[0];
  if (item?.kind !== 'fn' || item.body === null) throw new Error('expected a function with a body');
  return scanFunctionBody(item.body);
}

/** A compact view of each fact, for comparison. `=` marks a binding with an initialiser. */
function summary(list: readonly BodyFact[]): string[] {
  return list.map((fact) => {
    switch (fact.kind) {
      case 'call':
        return `call:${fact.path.join('::')}`;
      case 'method-call':
        return `method:${fact.method}`;
      case 'macro-call':
        return `macro:${fact.path.join('::')}!`;
      case 'path':
        return `path:${fact.segments.join('::')}`;
      case 'item':
        return `item:${fact.keyword}`;
      case 'let':
        return `let:${fact.bindings.map((b) => b.name).join(',')}${fact.hasInit ? '=' : ''}`;
      case 'for':
        return `for:${fact.bindings.map((b) => b.name).join(',')}`;
      case 'closure':
        return `closure:${fact.params.map((b) => b.name).join(',')}`;
      case 'match-arm':
        return `arm:${fact.bindings.map((b) => b.name).join(',')}`;
    }
  });
}

describe('rust body scan: calls and methods', () => {
  it('reads path calls, method calls and path references in order', () => {
    expect(summary(facts('fn f() { g(1); a.b(2); x.y; Foo::bar(); }'))).toEqual([
      'call:g',
      'path:a',
      'method:b',
      'path:x',
      'call:Foo::bar',
    ]);
  });

  it('scans the arguments of a call', () => {
    expect(summary(facts('fn f() { g(h(x)); }'))).toEqual(['call:g', 'call:h', 'path:x']);
  });

  it('skips turbofish arguments in a path and a method', () => {
    expect(summary(facts('fn f() { Vec::<u8>::new(); parse::<u8>(s); }'))).toEqual([
      'call:Vec::new',
      'call:parse',
      'path:s',
    ]);
  });

  it('treats a field access and a tuple index as neither call nor method', () => {
    expect(summary(facts('fn f() { t.0.name; }'))).toEqual(['path:t']);
  });

  it('gives the span of a call from its first token to its closing parenthesis', () => {
    const [call] = facts('fn f() { foo(1); }');
    expect(call?.span).toEqual({ line: 1, column: 10, endLine: 1, endColumn: 16 });
  });
});

describe('rust body scan: keywords, macros and items', () => {
  it('never treats a keyword as a call head', () => {
    expect(summary(facts('fn f() { if (x) { y() } }'))).toEqual(['path:x', 'call:y']);
  });

  it('records a macro invocation without scanning its tokens', () => {
    expect(summary(facts('fn f() { println!("{}", f(x)); }'))).toEqual(['macro:println!']);
  });

  it('skips nested items and leaves their bodies alone', () => {
    expect(summary(facts('fn f() { fn inner(a: u8) -> u8 { a } use std::fmt; }'))).toEqual([
      'item:fn',
      'item:use',
    ]);
  });

  it('scans a malformed body without throwing', () => {
    expect(() => facts('fn f() { g( }')).not.toThrow();
  });
});

describe('rust body scan: let bindings', () => {
  it('binds a simple name without reporting it as a path', () => {
    expect(summary(facts('fn f() { let x = 1; }'))).toEqual(['let:x=']);
  });

  it('binds names inside tuple and struct patterns, skipping field names and rest', () => {
    expect(summary(facts('fn f() { let (a, mut b) = p; let Point { x, y: z, .. } = q; }'))).toEqual(
      ['let:a,b=', 'path:p', 'let:x,z=', 'path:q'],
    );
  });

  it('does not bind wildcards, constants, unit variants or path heads', () => {
    expect(summary(facts('fn f() { let _ = g(); let Some(_) = o; let Foo::Bar = k; }'))).toEqual([
      'let:=',
      'call:g',
      'let:=',
      'path:o',
      'let:=',
      'path:k',
    ]);
  });

  it('records the type annotation and whether there is an initialiser', () => {
    const lets = facts('fn f() { let v: Vec<u8> = Vec::new(); let w: u8; }').filter(
      (fact) => fact.kind === 'let',
    );
    const [typed, untyped] = lets;
    expect(typed).toMatchObject({ kind: 'let', hasInit: true, type: { raw: 'Vec < u8 >' } });
    expect(untyped).toMatchObject({ kind: 'let', hasInit: false, type: { raw: 'u8' } });
  });

  it('scans the initialiser as an expression', () => {
    expect(summary(facts('fn f() { let v: Vec<u8> = Vec::new(); }'))).toEqual([
      'let:v=',
      'call:Vec::new',
    ]);
  });
});

describe('rust body scan: for, if let and while let', () => {
  it('binds the loop pattern and scans the iterator', () => {
    expect(summary(facts('fn f() { for (i, x) in v.iter().enumerate() {} }'))).toEqual([
      'for:i,x',
      'path:v',
      'method:iter',
      'method:enumerate',
    ]);
  });

  it('binds an if-let pattern', () => {
    expect(summary(facts('fn f() { if let Some(x) = opt { g(x) } }'))).toEqual([
      'let:x=',
      'path:opt',
      'call:g',
      'path:x',
    ]);
  });

  it('binds a while-let pattern', () => {
    expect(summary(facts('fn f() { while let Some(top) = stack.pop() {} }'))).toEqual([
      'let:top=',
      'path:stack',
      'method:pop',
    ]);
  });
});

describe('rust body scan: closures', () => {
  it('binds closure parameters and not the type after a colon', () => {
    expect(summary(facts('fn f() { let f = |a, b: u8| a + b; }'))).toEqual([
      'let:f=',
      'closure:a,b',
      'path:a',
      'path:b',
    ]);
  });

  it('handles an empty parameter list and a move closure', () => {
    expect(summary(facts('fn f() { let h = || 1; let k = move |y| y; }'))).toEqual([
      'let:h=',
      'closure:',
      'let:k=',
      'closure:y',
      'path:y',
    ]);
  });

  it('treats a bar after an operand as binary or, not a closure', () => {
    expect(summary(facts('fn f() { let z = a | b; }'))).toEqual(['let:z=', 'path:a', 'path:b']);
  });

  it('finds a closure inside a method argument', () => {
    expect(summary(facts('fn f() { v.iter().map(|x| x + 1); }'))).toEqual([
      'path:v',
      'method:iter',
      'method:map',
      'closure:x',
      'path:x',
    ]);
  });
});

describe('rust body scan: match arms', () => {
  it('binds arm patterns, scans guards and bodies, and skips uppercase variants', () => {
    expect(
      summary(facts('fn f() { match v { Some(x) if x > 0 => f(x), None => {}, _ => 0 } }')),
    ).toEqual(['path:v', 'arm:x', 'path:x', 'call:f', 'path:x', 'arm:', 'arm:']);
  });

  it('binds struct-pattern shorthand fields in an arm', () => {
    expect(summary(facts('fn f() { match p { Point { x, .. } => x, } }'))).toEqual([
      'path:p',
      'arm:x',
      'path:x',
    ]);
  });
});
