import type { CallArg, Comprehension, DictEntry, Expr, FStringPart, Param } from './ast.js';
import { TokenCursor } from './cursor.js';
import { tokenize, type Token } from './tokenizer.js';

/** Binary operator levels, loosest first. `**` and unary operators are handled by parseFactor. */
const BINARY_LEVELS: ReadonlyArray<readonly string[]> = [
  ['|'],
  ['^'],
  ['&'],
  ['<<', '>>'],
  ['+', '-'],
  ['*', '/', '//', '%', '@'],
];

const COMPARE_OPERATORS: ReadonlySet<string> = new Set(['<', '>', '==', '>=', '<=', '!=']);

const EXPRESSION_KEYWORDS: ReadonlySet<string> = new Set([
  'None',
  'True',
  'False',
  'not',
  'lambda',
  'await',
  'yield',
]);
const EXPRESSION_OPERATORS: ReadonlySet<string> = new Set([
  '(',
  '[',
  '{',
  '-',
  '+',
  '~',
  '*',
  '...',
]);

/** True when `token` can begin an expression, so a list or tuple may continue. */
export function canStartExpression(token: Token): boolean {
  switch (token.kind) {
    case 'name':
    case 'number':
    case 'string':
    case 'fstring_start':
      return true;
    case 'keyword':
      return EXPRESSION_KEYWORDS.has(token.value);
    case 'op':
      return EXPRESSION_OPERATORS.has(token.value);
    default:
      return false;
  }
}

const atComprehension = (c: TokenCursor): boolean =>
  c.isKeyword('for') || (c.isKeyword('async') && c.isKeyword('for', 1));

/** `test`: a conditional expression or a lambda. */
export function parseTest(c: TokenCursor): Expr {
  if (c.isKeyword('lambda')) return parseLambda(c);
  const start = c.peek();
  const body = parseOr(c);
  if (c.match('keyword', 'if') === undefined) return body;
  const test = parseOr(c);
  c.expect('keyword', 'else', "expected 'else' in conditional expression");
  const orelse = parseTest(c);
  return { kind: 'ifexp', test, body, orelse, span: c.spanFrom(start) };
}

/** `namedexpr_test`: `name := value`, or a plain test. */
export function parseNamedExpression(c: TokenCursor): Expr {
  const start = c.peek();
  if (c.is('name') && c.isOp(':=', 1)) {
    const target: Expr = { kind: 'name', id: c.advance().value, span: c.spanFrom(start) };
    c.advance();
    const value = parseTest(c);
    return { kind: 'namedexpr', target, value, span: c.spanFrom(start) };
  }
  return parseTest(c);
}

/** A list element: `*expr` or a named expression. */
function parseStarOrNamed(c: TokenCursor): Expr {
  const start = c.peek();
  if (c.match('op', '*') !== undefined) {
    const value = parseBinary(c, 0);
    return { kind: 'starred', value, span: c.spanFrom(start) };
  }
  return parseNamedExpression(c);
}

function parseStarOrTest(c: TokenCursor): Expr {
  const start = c.peek();
  if (c.match('op', '*') !== undefined) {
    const value = parseBinary(c, 0);
    return { kind: 'starred', value, span: c.spanFrom(start) };
  }
  return parseTest(c);
}

/** `star_expressions`: one expression, or a comma-separated tuple without parentheses. */
export function parseExpressionList(c: TokenCursor): Expr {
  const start = c.peek();
  const first = parseStarOrTest(c);
  if (!c.isOp(',')) return first;
  const elements = [first];
  while (c.match('op', ',') !== undefined) {
    if (!canStartExpression(c.peek())) break;
    elements.push(parseStarOrTest(c));
  }
  return { kind: 'tuple', elements, span: c.spanFrom(start) };
}

/** `yield`, `yield from`, or a bare `yield`. The cursor is on the `yield` keyword. */
export function parseYield(c: TokenCursor): Expr {
  const start = c.advance();
  if (c.match('keyword', 'from') !== undefined) {
    const value = parseTest(c);
    return { kind: 'yieldfrom', value, span: c.spanFrom(start) };
  }
  const value = canStartExpression(c.peek()) ? parseExpressionList(c) : null;
  return { kind: 'yield', value, span: c.spanFrom(start) };
}

/** A target list in a `for` clause: `a`, `a, b`, or `*rest, b`. */
export function parseTargetList(c: TokenCursor): Expr {
  const start = c.peek();
  const first = parseStarOrBinary(c);
  if (!c.isOp(',')) return first;
  const elements = [first];
  while (c.match('op', ',') !== undefined) {
    if (!canStartExpression(c.peek())) break;
    elements.push(parseStarOrBinary(c));
  }
  return { kind: 'tuple', elements, span: c.spanFrom(start) };
}

function parseStarOrBinary(c: TokenCursor): Expr {
  const start = c.peek();
  if (c.match('op', '*') !== undefined) {
    const value = parseBinary(c, 0);
    return { kind: 'starred', value, span: c.spanFrom(start) };
  }
  return parseBinary(c, 0);
}

function parseOr(c: TokenCursor): Expr {
  const start = c.peek();
  const first = parseAnd(c);
  if (!c.isKeyword('or')) return first;
  const values = [first];
  while (c.match('keyword', 'or') !== undefined) values.push(parseAnd(c));
  return { kind: 'boolop', op: 'or', values, span: c.spanFrom(start) };
}

function parseAnd(c: TokenCursor): Expr {
  const start = c.peek();
  const first = parseNot(c);
  if (!c.isKeyword('and')) return first;
  const values = [first];
  while (c.match('keyword', 'and') !== undefined) values.push(parseNot(c));
  return { kind: 'boolop', op: 'and', values, span: c.spanFrom(start) };
}

function parseNot(c: TokenCursor): Expr {
  const start = c.peek();
  if (c.match('keyword', 'not') !== undefined) {
    const operand = parseNot(c);
    return { kind: 'unaryop', op: 'not', operand, span: c.spanFrom(start) };
  }
  return parseComparison(c);
}

function parseComparison(c: TokenCursor): Expr {
  const start = c.peek();
  const left = parseBinary(c, 0);
  const ops: string[] = [];
  const comparators: Expr[] = [];
  for (;;) {
    const token = c.peek();
    let op: string | undefined;
    if (token.kind === 'op' && COMPARE_OPERATORS.has(token.value)) {
      op = token.value;
      c.advance();
    } else if (c.match('keyword', 'in') !== undefined) {
      op = 'in';
    } else if (c.isKeyword('not') && c.isKeyword('in', 1)) {
      c.advance();
      c.advance();
      op = 'not in';
    } else if (c.match('keyword', 'is') !== undefined) {
      op = c.match('keyword', 'not') === undefined ? 'is' : 'is not';
    }
    if (op === undefined) break;
    ops.push(op);
    comparators.push(parseBinary(c, 0));
  }
  if (ops.length === 0) return left;
  return { kind: 'compare', left, ops, comparators, span: c.spanFrom(start) };
}

/** Left-associative binary operators, by precedence level. */
function parseBinary(c: TokenCursor, level: number): Expr {
  const operators = BINARY_LEVELS[level];
  if (operators === undefined) return parseFactor(c);
  const start = c.peek();
  let left = parseBinary(c, level + 1);
  for (;;) {
    const token = c.peek();
    if (token.kind !== 'op' || !operators.includes(token.value)) break;
    c.advance();
    const right = parseBinary(c, level + 1);
    left = { kind: 'binop', op: token.value, left, right, span: c.spanFrom(start) };
  }
  return left;
}

function parseFactor(c: TokenCursor): Expr {
  const start = c.peek();
  if (start.kind === 'op' && (start.value === '+' || start.value === '-' || start.value === '~')) {
    c.advance();
    const operand = parseFactor(c);
    return { kind: 'unaryop', op: start.value, operand, span: c.spanFrom(start) };
  }
  return parsePower(c);
}

/** `**` binds tighter than unary operators on its left and is right-associative. */
function parsePower(c: TokenCursor): Expr {
  const start = c.peek();
  const base = parseAwaitPrimary(c);
  if (c.match('op', '**') === undefined) return base;
  const exponent = parseFactor(c);
  return { kind: 'binop', op: '**', left: base, right: exponent, span: c.spanFrom(start) };
}

function parseAwaitPrimary(c: TokenCursor): Expr {
  const start = c.peek();
  if (c.match('keyword', 'await') !== undefined) {
    const value = parsePrimary(c);
    return { kind: 'await', value, span: c.spanFrom(start) };
  }
  return parsePrimary(c);
}

/** An atom followed by attribute, call and subscript trailers. */
function parsePrimary(c: TokenCursor): Expr {
  const start = c.peek();
  let expr = parseAtom(c);
  for (;;) {
    if (c.match('op', '.') !== undefined) {
      const attr = c.expect('name', undefined, "expected an attribute name after '.'");
      expr = { kind: 'attribute', value: expr, attr: attr.value, span: c.spanFrom(start) };
    } else if (c.isOp('(')) {
      const args = parseCallArgs(c);
      expr = { kind: 'call', func: expr, args, span: c.spanFrom(start) };
    } else if (c.match('op', '[') !== undefined) {
      const index = parseSubscriptList(c);
      c.expect('op', ']', "expected ']' to close subscript");
      expr = { kind: 'subscript', value: expr, index, span: c.spanFrom(start) };
    } else {
      return expr;
    }
  }
}

export function parseAtom(c: TokenCursor): Expr {
  const token = c.peek();
  switch (token.kind) {
    case 'name':
      c.advance();
      return { kind: 'name', id: token.value, span: c.spanFrom(token) };
    case 'number':
      c.advance();
      return { kind: 'constant', type: 'number', raw: token.value, span: c.spanFrom(token) };
    case 'string':
    case 'fstring_start':
      return parseStrings(c);
    case 'keyword':
      if (token.value === 'True' || token.value === 'False') {
        c.advance();
        return { kind: 'constant', type: 'bool', raw: token.value, span: c.spanFrom(token) };
      }
      if (token.value === 'None') {
        c.advance();
        return { kind: 'constant', type: 'none', raw: token.value, span: c.spanFrom(token) };
      }
      return c.fail('invalid syntax', token);
    case 'op':
      if (token.value === '...') {
        c.advance();
        return { kind: 'constant', type: 'ellipsis', raw: '...', span: c.spanFrom(token) };
      }
      if (token.value === '(') return parseParenthesized(c);
      if (token.value === '[') return parseListDisplay(c);
      if (token.value === '{') return parseBraceDisplay(c);
      return c.fail('invalid syntax', token);
    default:
      return c.fail('invalid syntax', token);
  }
}

/** Adjacent string literals form one expression. Any f-string makes the whole thing an f-string. */
function parseStrings(c: TokenCursor): Expr {
  const start = c.peek();
  const parts: FStringPart[] = [];
  const raws: string[] = [];
  let sawFString = false;
  let sawBytes = false;
  let sawText = false;
  for (;;) {
    const token = c.peek();
    if (token.kind === 'string') {
      c.advance();
      raws.push(token.value);
      const prefix = token.value.slice(0, token.value.search(/["']/));
      if (prefix.toLowerCase().includes('b')) sawBytes = true;
      else sawText = true;
      parts.push({ kind: 'literal', raw: token.value, span: c.spanFrom(token) });
    } else if (token.kind === 'fstring_start') {
      sawFString = true;
      sawText = true;
      c.advance();
      parts.push(...parseFStringBody(c));
      c.expect('fstring_end', undefined, 'unterminated f-string');
    } else {
      break;
    }
  }
  if (sawBytes && sawText) c.fail('cannot mix bytes and nonbytes literals', start);
  if (sawFString) return { kind: 'fstring', parts, span: c.spanFrom(start) };
  return {
    kind: 'constant',
    type: sawBytes ? 'bytes' : 'str',
    raw: raws.join(' '),
    span: c.spanFrom(start),
  };
}

/** The literal and field parts of an f-string, up to the token that ends the body. */
function parseFStringBody(c: TokenCursor): FStringPart[] {
  const parts: FStringPart[] = [];
  for (;;) {
    const token = c.peek();
    if (token.kind === 'fstring_middle') {
      c.advance();
      parts.push({ kind: 'literal', raw: token.value, span: c.spanFrom(token) });
    } else if (token.kind === 'op' && token.value === '{') {
      parts.push(parseField(c));
    } else {
      return parts;
    }
  }
}

/** A replacement field `{expr[=][!conv][:spec]}`. The cursor is on the opening brace. */
function parseField(c: TokenCursor): FStringPart {
  const open = c.advance();
  const expr = parseExpressionList(c);
  const debug = c.match('op', '=') !== undefined;
  let conversion: string | null = null;
  if (c.match('op', '!') !== undefined) {
    conversion = c.expect('name', undefined, "expected a conversion after '!'").value;
  }
  let spec: FStringPart[] | null = null;
  if (c.match('op', ':') !== undefined) spec = parseFStringBody(c);
  c.expect('op', '}', "expected '}' to close the replacement field");
  return { kind: 'field', expr, debug, conversion, spec, span: c.spanFrom(open) };
}

/** `(`: a parenthesized expression, a tuple, a generator, or a parenthesized yield. */
function parseParenthesized(c: TokenCursor): Expr {
  const open = c.advance();
  if (c.match('op', ')') !== undefined) {
    return { kind: 'tuple', elements: [], span: c.spanFrom(open) };
  }
  if (c.isKeyword('yield')) {
    const value = parseYield(c);
    c.expect('op', ')', "expected ')' after yield");
    return value;
  }
  const first = parseStarOrNamed(c);
  if (atComprehension(c)) {
    const generators = parseComprehensionClauses(c);
    c.expect('op', ')', "expected ')' to close generator");
    return {
      kind: 'comprehension',
      form: 'generator',
      element: first,
      value: null,
      generators,
      span: c.spanFrom(open),
    };
  }
  if (c.match('op', ')') !== undefined) return first;
  const elements = [first];
  let sawComma = false;
  while (c.match('op', ',') !== undefined) {
    sawComma = true;
    if (c.isOp(')')) break;
    elements.push(parseStarOrNamed(c));
  }
  c.expect('op', ')', "expected ')' to close parenthesis");
  return sawComma ? { kind: 'tuple', elements, span: c.spanFrom(open) } : first;
}

function parseListDisplay(c: TokenCursor): Expr {
  const open = c.advance();
  if (c.match('op', ']') !== undefined) {
    return { kind: 'list', elements: [], span: c.spanFrom(open) };
  }
  const first = parseStarOrNamed(c);
  if (atComprehension(c)) {
    const generators = parseComprehensionClauses(c);
    c.expect('op', ']', "expected ']' to close comprehension");
    return {
      kind: 'comprehension',
      form: 'list',
      element: first,
      value: null,
      generators,
      span: c.spanFrom(open),
    };
  }
  const elements = [first];
  while (c.match('op', ',') !== undefined) {
    if (c.isOp(']')) break;
    elements.push(parseStarOrNamed(c));
  }
  c.expect('op', ']', "expected ']' to close list");
  return { kind: 'list', elements, span: c.spanFrom(open) };
}

/** `{`: a dict, a set, or a comprehension of either. */
function parseBraceDisplay(c: TokenCursor): Expr {
  const open = c.advance();
  if (c.match('op', '}') !== undefined) {
    return { kind: 'dict', entries: [], span: c.spanFrom(open) };
  }
  if (c.isOp('**')) {
    return finishDict(c, open, [parseDictEntry(c)]);
  }
  const first = parseStarOrNamed(c);
  if (c.match('op', ':') !== undefined) {
    const value = parseTest(c);
    if (atComprehension(c)) {
      const generators = parseComprehensionClauses(c);
      c.expect('op', '}', "expected '}' to close comprehension");
      return {
        kind: 'comprehension',
        form: 'dict',
        element: first,
        value,
        generators,
        span: c.spanFrom(open),
      };
    }
    return finishDict(c, open, [{ key: first, value }]);
  }
  if (atComprehension(c)) {
    const generators = parseComprehensionClauses(c);
    c.expect('op', '}', "expected '}' to close comprehension");
    return {
      kind: 'comprehension',
      form: 'set',
      element: first,
      value: null,
      generators,
      span: c.spanFrom(open),
    };
  }
  const elements = [first];
  while (c.match('op', ',') !== undefined) {
    if (c.isOp('}')) break;
    elements.push(parseStarOrNamed(c));
  }
  c.expect('op', '}', "expected '}' to close set");
  return { kind: 'set', elements, span: c.spanFrom(open) };
}

function parseDictEntry(c: TokenCursor): DictEntry {
  if (c.match('op', '**') !== undefined) {
    return { key: null, value: parseBinary(c, 0) };
  }
  const key = parseTest(c);
  c.expect('op', ':', "expected ':' in dict entry");
  return { key, value: parseTest(c) };
}

/** Entries after the first, then the closing brace. The first entry is already parsed. */
function finishDict(c: TokenCursor, open: Token, entries: DictEntry[]): Expr {
  while (c.match('op', ',') !== undefined) {
    if (c.isOp('}')) break;
    entries.push(parseDictEntry(c));
  }
  c.expect('op', '}', "expected '}' to close dict");
  return { kind: 'dict', entries, span: c.spanFrom(open) };
}

/** Comprehension clauses: one or more `for` clauses, each with optional `if` filters. */
function parseComprehensionClauses(c: TokenCursor): Comprehension[] {
  const generators: Comprehension[] = [];
  while (atComprehension(c)) {
    const isAsync = c.match('keyword', 'async') !== undefined;
    c.expect('keyword', 'for', "expected 'for'");
    const target = parseTargetList(c);
    c.expect('keyword', 'in', "expected 'in' in comprehension");
    const iter = parseOr(c);
    const ifs: Expr[] = [];
    while (c.match('keyword', 'if') !== undefined) {
      ifs.push(c.isKeyword('lambda') ? parseLambda(c) : parseOr(c));
    }
    generators.push({ target, iter, ifs, isAsync });
  }
  return generators;
}

/** Subscript contents: a single item, or a tuple of items. */
function parseSubscriptList(c: TokenCursor): Expr {
  const start = c.peek();
  const first = parseSubscriptItem(c);
  if (!c.isOp(',')) return first;
  const elements = [first];
  while (c.match('op', ',') !== undefined) {
    if (c.isOp(']')) break;
    elements.push(parseSubscriptItem(c));
  }
  return { kind: 'tuple', elements, span: c.spanFrom(start) };
}

function parseSubscriptItem(c: TokenCursor): Expr {
  const start = c.peek();
  let lower: Expr | null = null;
  if (!c.isOp(':')) {
    const first = parseStarOrNamed(c);
    if (!c.isOp(':')) return first;
    lower = first;
  }
  c.expect('op', ':', "expected ':' in slice");
  const upper = canStartExpression(c.peek()) ? parseTest(c) : null;
  let step: Expr | null = null;
  if (c.match('op', ':') !== undefined && canStartExpression(c.peek())) {
    step = parseTest(c);
  }
  return { kind: 'slice', lower, upper, step, span: c.spanFrom(start) };
}

/** Call arguments, including the parentheses. A lone generator argument needs no extra parentheses. */
export function parseCallArgs(c: TokenCursor): CallArg[] {
  c.expect('op', '(', "expected '(' to start call arguments");
  const args: CallArg[] = [];
  while (!c.isOp(')')) {
    args.push(parseCallArg(c));
    if (c.match('op', ',') === undefined) break;
  }
  c.expect('op', ')', "expected ')' to close call");
  return args;
}

function parseCallArg(c: TokenCursor): CallArg {
  const start = c.peek();
  if (c.match('op', '*') !== undefined) {
    const value = parseTest(c);
    return { kind: 'star', name: null, value, span: c.spanFrom(start) };
  }
  if (c.match('op', '**') !== undefined) {
    const value = parseTest(c);
    return { kind: 'double-star', name: null, value, span: c.spanFrom(start) };
  }
  if (c.is('name') && c.isOp('=', 1)) {
    const name = c.advance().value;
    c.advance();
    const value = parseTest(c);
    return { kind: 'keyword', name, value, span: c.spanFrom(start) };
  }
  let value = parseNamedExpression(c);
  if (atComprehension(c)) {
    const generators = parseComprehensionClauses(c);
    value = {
      kind: 'comprehension',
      form: 'generator',
      element: value,
      value: null,
      generators,
      span: c.spanFrom(start),
    };
  }
  return { kind: 'positional', name: null, value, span: c.spanFrom(start) };
}

/** `lambda` parameters `:` body. The cursor is on the `lambda` keyword. */
function parseLambda(c: TokenCursor): Expr {
  const start = c.advance();
  const params = parseParameters(c, ':', false);
  c.expect('op', ':', "expected ':' after lambda parameters");
  const body = parseTest(c);
  return { kind: 'lambda', params, body, span: c.spanFrom(start) };
}

/**
 * Parameters up to `closer`, which is not consumed. Annotations are accepted
 * only when `allowAnnotations` is set (function definitions, not lambdas).
 */
export function parseParameters(
  c: TokenCursor,
  closer: string,
  allowAnnotations: boolean,
): Param[] {
  const params: Param[] = [];
  const annotation = (): Expr | null =>
    allowAnnotations && c.match('op', ':') !== undefined ? parseTest(c) : null;
  while (!c.isOp(closer)) {
    const start = c.peek();
    if (c.match('op', '/') !== undefined) {
      params.push({
        kind: 'slash',
        name: null,
        annotation: null,
        default: null,
        span: c.spanFrom(start),
      });
    } else if (c.match('op', '**') !== undefined) {
      const name = c.expect('name', undefined, 'expected a name after **').value;
      const note = annotation();
      params.push({
        kind: 'kwarg',
        name,
        annotation: note,
        default: null,
        span: c.spanFrom(start),
      });
    } else if (c.match('op', '*') !== undefined) {
      if (c.is('name')) {
        const name = c.advance().value;
        const note = annotation();
        params.push({
          kind: 'vararg',
          name,
          annotation: note,
          default: null,
          span: c.spanFrom(start),
        });
      } else {
        params.push({
          kind: 'bare-star',
          name: null,
          annotation: null,
          default: null,
          span: c.spanFrom(start),
        });
      }
    } else {
      const name = c.expect('name', undefined, 'expected a parameter name').value;
      const note = annotation();
      const defaultValue = c.match('op', '=') !== undefined ? parseTest(c) : null;
      params.push({
        kind: 'normal',
        name,
        annotation: note,
        default: defaultValue,
        span: c.spanFrom(start),
      });
    }
    if (c.match('op', ',') === undefined) break;
  }
  return params;
}

/** Parses the whole text as one expression list. Used by tests and the statement parser. */
export function parseExpressionSource(source: string): Expr {
  const cursor = new TokenCursor(tokenize(source).tokens);
  const expr = parseExpressionList(cursor);
  cursor.match('newline');
  cursor.expect('endmarker', undefined, 'unexpected input after expression');
  return expr;
}

/** A bitwise-or expression: the tightest level that excludes comparisons and boolean operators. */
export function parseBitOr(c: TokenCursor): Expr {
  return parseBinary(c, 0);
}
