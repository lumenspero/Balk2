import type { Expr, Pattern } from './ast.js';
import type { TokenCursor } from './cursor.js';
import { parseAtom } from './expression-parser.js';
import type { Token } from './tokenizer.js';

/** A `case` pattern, including the open sequence form `case a, *rest:`. */
export function parsePattern(c: TokenCursor): Pattern {
  const start = c.peek();
  const first = parseMaybeStar(c);
  if (!c.isOp(',') && first.kind !== 'star') return first;
  const elements = [first];
  while (c.match('op', ',') !== undefined) {
    if (c.isOp(':') || c.isKeyword('if')) break;
    elements.push(parseMaybeStar(c));
  }
  return { kind: 'sequence', elements, span: c.spanFrom(start) };
}

function parseMaybeStar(c: TokenCursor): Pattern {
  const start = c.peek();
  if (c.match('op', '*') !== undefined) {
    const name = c.expect('name', undefined, "expected a name after '*'").value;
    return { kind: 'star', name: name === '_' ? null : name, span: c.spanFrom(start) };
  }
  return parseAsPattern(c);
}

/** `or_pattern ['as' NAME]` */
function parseAsPattern(c: TokenCursor): Pattern {
  const start = c.peek();
  const pattern = parseOrPattern(c);
  if (c.match('keyword', 'as') === undefined) return pattern;
  const name = c.expect('name', undefined, "expected a name after 'as'").value;
  return { kind: 'as', pattern, name, span: c.spanFrom(start) };
}

function parseOrPattern(c: TokenCursor): Pattern {
  const start = c.peek();
  const first = parseClosedPattern(c);
  if (!c.isOp('|')) return first;
  const alternatives = [first];
  while (c.match('op', '|') !== undefined) alternatives.push(parseClosedPattern(c));
  return { kind: 'or', alternatives, span: c.spanFrom(start) };
}

function parseClosedPattern(c: TokenCursor): Pattern {
  const start = c.peek();
  if (start.kind === 'name') {
    if (c.isOp('.', 1) || c.isOp('(', 1)) {
      const cls = parseDottedName(c);
      if (c.isOp('(')) return parseClassPattern(c, cls, start);
      return { kind: 'value', value: cls, span: c.spanFrom(start) };
    }
    c.advance();
    return start.value === '_'
      ? { kind: 'wildcard', span: c.spanFrom(start) }
      : { kind: 'capture', name: start.value, span: c.spanFrom(start) };
  }
  if (
    start.kind === 'number' ||
    start.kind === 'string' ||
    (start.kind === 'keyword' && isLiteralKeyword(start))
  ) {
    return { kind: 'literal', value: parseLiteral(c), span: c.spanFrom(start) };
  }
  if (c.isOp('-')) {
    return { kind: 'literal', value: parseLiteral(c), span: c.spanFrom(start) };
  }
  if (c.match('op', '(') !== undefined) {
    if (c.match('op', ')') !== undefined)
      return { kind: 'sequence', elements: [], span: c.spanFrom(start) };
    const first = parseMaybeStar(c);
    if (c.match('op', ')') !== undefined && first.kind !== 'star') return first;
    const elements = [first];
    while (c.match('op', ',') !== undefined) {
      if (c.isOp(')')) break;
      elements.push(parseMaybeStar(c));
    }
    c.expect('op', ')', "expected ')' to close sequence pattern");
    return { kind: 'sequence', elements, span: c.spanFrom(start) };
  }
  if (c.match('op', '[') !== undefined) {
    const elements = parseSequenceItems(c, ']');
    c.expect('op', ']', "expected ']' to close sequence pattern");
    return { kind: 'sequence', elements, span: c.spanFrom(start) };
  }
  if (c.match('op', '{') !== undefined) return parseMappingPattern(c, start);
  return c.fail('invalid pattern', start);
}

const isLiteralKeyword = (token: Token): boolean =>
  token.value === 'None' || token.value === 'True' || token.value === 'False';

function parseSequenceItems(c: TokenCursor, closer: string): Pattern[] {
  const items: Pattern[] = [];
  while (!c.isOp(closer)) {
    items.push(parseMaybeStar(c));
    if (c.match('op', ',') === undefined) break;
  }
  return items;
}

/** `{` is already consumed. */
function parseMappingPattern(c: TokenCursor, start: Token): Pattern {
  const entries: { key: Expr; pattern: Pattern }[] = [];
  let rest: string | null = null;
  while (!c.isOp('}')) {
    if (c.match('op', '**') !== undefined) {
      rest = c.expect('name', undefined, "expected a name after '**'").value;
    } else {
      const key = c.is('name') ? parseDottedName(c) : parseLiteral(c);
      c.expect('op', ':', "expected ':' in mapping pattern");
      entries.push({ key, pattern: parseAsPattern(c) });
    }
    if (c.match('op', ',') === undefined) break;
  }
  c.expect('op', '}', "expected '}' to close mapping pattern");
  return { kind: 'mapping', entries, rest, span: c.spanFrom(start) };
}

function parseClassPattern(c: TokenCursor, cls: Expr, start: Token): Pattern {
  c.expect('op', '(', "expected '(' in class pattern");
  const positional: Pattern[] = [];
  const keywords: { name: string; pattern: Pattern }[] = [];
  while (!c.isOp(')')) {
    if (c.is('name') && c.isOp('=', 1)) {
      const name = c.advance().value;
      c.advance();
      keywords.push({ name, pattern: parseAsPattern(c) });
    } else {
      positional.push(parseAsPattern(c));
    }
    if (c.match('op', ',') === undefined) break;
  }
  c.expect('op', ')', "expected ')' to close class pattern");
  return { kind: 'class', cls, positional, keywords, span: c.spanFrom(start) };
}

/** `NAME ('.' NAME)*` as an attribute chain. */
function parseDottedName(c: TokenCursor): Expr {
  const start = c.peek();
  const first = c.expect('name', undefined, 'expected a name');
  let expr: Expr = { kind: 'name', id: first.value, span: c.spanFrom(start) };
  while (c.match('op', '.') !== undefined) {
    const attr = c.expect('name', undefined, "expected a name after '.'");
    expr = { kind: 'attribute', value: expr, attr: attr.value, span: c.spanFrom(start) };
  }
  return expr;
}

/** A literal: a signed number, optionally with an imaginary part, a string, or None/True/False. */
function parseLiteral(c: TokenCursor): Expr {
  const start = c.peek();
  if (c.match('op', '-') !== undefined) {
    const operand = parseAtom(c);
    const negative: Expr = { kind: 'unaryop', op: '-', operand, span: c.spanFrom(start) };
    return parseComplexTail(c, negative, start);
  }
  const atom = parseAtom(c);
  return parseComplexTail(c, atom, start);
}

/** `1 + 2j`: the real part is already parsed, so only the `+`/`-` and imaginary part remain. */
function parseComplexTail(c: TokenCursor, left: Expr, start: Token): Expr {
  if (!c.isOp('+') && !c.isOp('-')) return left;
  const op = c.advance().value;
  const right = parseAtom(c);
  return { kind: 'binop', op, left, right, span: c.spanFrom(start) };
}
