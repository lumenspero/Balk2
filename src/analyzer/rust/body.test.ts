import { describe, expect, it } from 'vitest';
import { parseRustFile } from './items.js';
import { scanFunctionBody, type BodyFact } from './body.js';

/** Scans the body of the first function in `source`. */
function facts(source: string): BodyFact[] {
  const item = parseRustFile(source).items[0];
  if (item?.kind !== 'fn' || item.body === null) throw new Error('expected a function with a body');
  return scanFunctionBody(item.body);
}

/** A compact view of each fact, for comparison. */
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
