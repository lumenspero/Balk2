import type { Alias, ExceptHandler, Expr, MatchCase, Stmt, TypeParam, WithItem } from './ast.js';
import { PythonSyntaxError, TokenCursor, type ParseNote } from './cursor.js';
import {
  canStartExpression,
  parseBitOr,
  parseCallArgs,
  parseExpressionList,
  parseNamedExpression,
  parseParameters,
  parseTargetList,
  parseTest,
  parseYield,
} from './expression-parser.js';
import { parsePattern } from './pattern-parser.js';
import { checkSingleTarget, checkTarget } from './targets.js';
import { tokenize, type Token } from './tokenizer.js';

const AUGMENTED_OPERATORS: ReadonlySet<string> = new Set([
  '+=',
  '-=',
  '*=',
  '/=',
  '//=',
  '%=',
  '**=',
  '>>=',
  '<<=',
  '&=',
  '^=',
  '|=',
  '@=',
]);

/**
 * Parses a module, recovering from syntax errors. Every problem becomes a note,
 * and the statements around it are still parsed. Never throws on malformed input.
 */
export function parseModuleRecovering(source: string): ModuleParse {
  const tokenized = tokenize(source);
  const cursor = new TokenCursor(tokenized.tokens);
  for (const note of tokenized.errors) cursor.addNote(note);
  const body: Stmt[] = [];
  while (!cursor.is('endmarker')) body.push(...parseStatementRecovering(cursor));
  const errors = [...cursor.notes].sort((a, b) => a.line - b.line || a.column - b.column);
  return { body, errors };
}

/**
 * Parses a module and throws the first problem found. Used where a single
 * error is wanted, such as tests and tools that handle one file at a time.
 */
export function parseModule(source: string): readonly Stmt[] {
  const { body, errors } = parseModuleRecovering(source);
  const first = errors[0];
  if (first !== undefined) throw new PythonSyntaxError(first.message, first.line, first.column);
  return body;
}

export interface ModuleParse {
  readonly body: readonly Stmt[];
  readonly errors: readonly ParseNote[];
}

/** Parses one statement. On a syntax error, records the note and skips past the broken statement. */
function parseStatementRecovering(c: TokenCursor): Stmt[] {
  const start = c.position();
  try {
    return parseStatement(c);
  } catch (error) {
    if (!(error instanceof PythonSyntaxError)) throw error;
    c.addNote({ message: error.message, line: error.line, column: error.column });
    recoverPastStatement(c, start);
    return [];
  }
}

/**
 * Skips the rest of a broken statement: its tokens up to the end of the line, and
 * the indented block it introduced. It stops at a dedent, which closes the enclosing
 * block. It always consumes at least one token, so recovery cannot loop.
 */
function recoverPastStatement(c: TokenCursor, start: number): void {
  while (!c.is('newline') && !c.is('endmarker') && !c.is('indent') && !c.is('dedent')) c.advance();
  if (c.is('newline')) c.advance();
  if (c.is('indent')) skipIndentedBlock(c);
  if (c.position() === start && !c.is('endmarker')) c.advance();
}

/** Skips an indented block, including nested blocks. The cursor must be on an indent. */
function skipIndentedBlock(c: TokenCursor): void {
  let depth = 0;
  while (!c.is('endmarker')) {
    if (c.is('indent')) depth += 1;
    else if (c.is('dedent')) depth -= 1;
    c.advance();
    if (depth === 0) return;
  }
}

/** One compound statement, or one line of simple statements. */
export function parseStatement(c: TokenCursor): Stmt[] {
  const t = c.peek();
  if (t.kind === 'indent') return c.fail('unexpected indent', t);
  if (t.kind === 'op' && t.value === '@') return [parseDecorated(c)];
  if (t.kind === 'keyword') {
    switch (t.value) {
      case 'if':
        return [parseIf(c)];
      case 'while':
        return [parseWhile(c)];
      case 'for':
        return [parseFor(c, false)];
      case 'try':
        return [parseTry(c)];
      case 'with':
        return [parseWith(c, false)];
      case 'def':
        return [parseFuncDef(c, [], false)];
      case 'class':
        return [parseClassDef(c, [])];
      case 'async':
        return [parseAsync(c)];
      default:
        break;
    }
  }
  if (t.kind === 'name' && t.value === 'match' && isMatchStatement(c)) return [parseMatch(c)];
  return parseSimpleStatements(c);
}

/** A block after `:`. An inline body is simple statements on the same line. */
export function parseBlock(c: TokenCursor): Stmt[] {
  c.expect('op', ':', "expected ':'");
  if (c.match('newline') === undefined) return parseSimpleStatements(c);
  c.expect('indent', undefined, 'expected an indented block');
  const body: Stmt[] = [];
  while (!c.is('dedent') && !c.is('endmarker')) body.push(...parseStatementRecovering(c));
  c.match('dedent');
  return body;
}

function parseSimpleStatements(c: TokenCursor): Stmt[] {
  const statements = [parseSimpleStatement(c)];
  while (c.match('op', ';') !== undefined) {
    if (c.is('newline') || c.is('endmarker')) break;
    statements.push(parseSimpleStatement(c));
  }
  c.expect('newline', undefined, 'expected end of statement');
  return statements;
}

function parseSimpleStatement(c: TokenCursor): Stmt {
  const t = c.peek();
  if (t.kind === 'keyword') {
    switch (t.value) {
      case 'pass':
        c.advance();
        return { kind: 'pass', span: c.spanFrom(t) };
      case 'break':
        c.advance();
        return { kind: 'break', span: c.spanFrom(t) };
      case 'continue':
        c.advance();
        return { kind: 'continue', span: c.spanFrom(t) };
      case 'return':
        return parseReturn(c);
      case 'raise':
        return parseRaise(c);
      case 'global':
      case 'nonlocal':
        return parseGlobal(c);
      case 'del':
        return parseDelete(c);
      case 'assert':
        return parseAssert(c);
      case 'import':
        return parseImport(c);
      case 'from':
        return parseFromImport(c);
      default:
        break;
    }
  }
  if (
    t.kind === 'name' &&
    t.value === 'type' &&
    c.is('name', undefined, 1) &&
    (c.isOp('=', 2) || c.isOp('[', 2))
  ) {
    return parseTypeAlias(c);
  }
  return parseExpressionStatement(c);
}

function parseReturn(c: TokenCursor): Stmt {
  const start = c.advance();
  const value = canStartExpression(c.peek()) ? parseExpressionList(c) : null;
  return { kind: 'return', value, span: c.spanFrom(start) };
}

function parseRaise(c: TokenCursor): Stmt {
  const start = c.advance();
  const exc = canStartExpression(c.peek()) ? parseTest(c) : null;
  const cause = exc !== null && c.match('keyword', 'from') !== undefined ? parseTest(c) : null;
  return { kind: 'raise', exc, cause, span: c.spanFrom(start) };
}

function parseGlobal(c: TokenCursor): Stmt {
  const start = c.advance();
  const names: string[] = [c.expect('name', undefined, 'expected a name').value];
  while (c.match('op', ',') !== undefined) {
    names.push(c.expect('name', undefined, 'expected a name').value);
  }
  return { kind: start.value === 'global' ? 'global' : 'nonlocal', names, span: c.spanFrom(start) };
}

function parseDelete(c: TokenCursor): Stmt {
  const start = c.advance();
  const target = parseTargetList(c);
  const targets = target.kind === 'tuple' ? [...target.elements] : [target];
  targets.forEach((t) => checkTarget(t, 'delete'));
  return { kind: 'delete', targets, span: c.spanFrom(start) };
}

function parseAssert(c: TokenCursor): Stmt {
  const start = c.advance();
  const test = parseTest(c);
  const msg = c.match('op', ',') !== undefined ? parseTest(c) : null;
  return { kind: 'assert', test, msg, span: c.spanFrom(start) };
}

/** A dotted name such as `a.b.c`, returned as text. */
function parseDottedText(c: TokenCursor): string {
  const parts = [c.expect('name', undefined, 'expected a module name').value];
  while (c.match('op', '.') !== undefined) {
    parts.push(c.expect('name', undefined, "expected a name after '.'").value);
  }
  return parts.join('.');
}

function parseAliasName(c: TokenCursor): string | null {
  if (c.match('keyword', 'as') === undefined) return null;
  return c.expect('name', undefined, "expected a name after 'as'").value;
}

function parseImport(c: TokenCursor): Stmt {
  const start = c.advance();
  const names: Alias[] = [];
  do {
    const aliasStart = c.peek();
    const name = parseDottedText(c);
    const asname = parseAliasName(c);
    names.push({ name, asname, span: c.spanFrom(aliasStart) });
  } while (c.match('op', ',') !== undefined);
  return { kind: 'import', names, span: c.spanFrom(start) };
}

function parseFromImport(c: TokenCursor): Stmt {
  const start = c.advance();
  let level = 0;
  for (;;) {
    if (c.match('op', '.') !== undefined) level += 1;
    else if (c.match('op', '...') !== undefined) level += 3;
    else break;
  }
  const module = c.is('name') ? parseDottedText(c) : null;
  if (module === null && level === 0) c.fail('expected a module name');
  c.expect('keyword', 'import', "expected 'import'");
  if (c.match('op', '*') !== undefined) {
    return { kind: 'importfrom', module, level, names: 'star', span: c.spanFrom(start) };
  }
  const parenthesized = c.match('op', '(') !== undefined;
  const names: Alias[] = [];
  do {
    if (parenthesized && c.isOp(')')) break;
    const aliasStart = c.peek();
    const name = c.expect('name', undefined, 'expected a name to import').value;
    const asname = parseAliasName(c);
    names.push({ name, asname, span: c.spanFrom(aliasStart) });
  } while (c.match('op', ',') !== undefined);
  if (parenthesized) c.expect('op', ')', "expected ')' to close import list");
  return { kind: 'importfrom', module, level, names, span: c.spanFrom(start) };
}

/** The right-hand side of an assignment: a `yield`, or an expression list. */
function parseRhs(c: TokenCursor): Expr {
  return c.isKeyword('yield') ? parseYield(c) : parseExpressionList(c);
}

function parseExpressionStatement(c: TokenCursor): Stmt {
  const start = c.peek();
  const first = c.isKeyword('yield') ? parseYield(c) : parseExpressionList(c);
  if (c.match('op', ':') !== undefined) {
    checkSingleTarget(first, 'annotated');
    const annotation = parseTest(c);
    const value = c.match('op', '=') !== undefined ? parseRhs(c) : null;
    return { kind: 'annassign', target: first, annotation, value, span: c.spanFrom(start) };
  }
  const augmented = c.peek();
  if (augmented.kind === 'op' && AUGMENTED_OPERATORS.has(augmented.value)) {
    c.advance();
    checkSingleTarget(first, 'augmented');
    const value = parseRhs(c);
    return {
      kind: 'augassign',
      target: first,
      op: augmented.value,
      value,
      span: c.spanFrom(start),
    };
  }
  if (!c.isOp('=')) return { kind: 'expr', value: first, span: c.spanFrom(start) };
  const parts: Expr[] = [first];
  while (c.match('op', '=') !== undefined) parts.push(parseRhs(c));
  const value = parts.pop() ?? first;
  parts.forEach((part) => checkTarget(part));
  return { kind: 'assign', targets: parts, value, span: c.spanFrom(start) };
}

function parseAsync(c: TokenCursor): Stmt {
  const start = c.advance();
  if (c.isKeyword('def')) return parseFuncDef(c, [], true, start);
  if (c.isKeyword('for')) return parseFor(c, true, start);
  if (c.isKeyword('with')) return parseWith(c, true, start);
  return c.fail('invalid syntax', start);
}

function parseDecorated(c: TokenCursor): Stmt {
  const decorators: Expr[] = [];
  while (c.match('op', '@') !== undefined) {
    decorators.push(parseNamedExpression(c));
    c.expect('newline', undefined, 'expected end of line after decorator');
  }
  const start = c.peek();
  if (c.isKeyword('def')) return parseFuncDef(c, decorators, false, start);
  if (c.isKeyword('async') && c.isKeyword('def', 1)) {
    c.advance();
    return parseFuncDef(c, decorators, true, start);
  }
  if (c.isKeyword('class')) return parseClassDef(c, decorators, start);
  return c.fail('expected a function or class after a decorator', start);
}

function parseFuncDef(
  c: TokenCursor,
  decorators: readonly Expr[],
  isAsync: boolean,
  start: Token = c.peek(),
): Stmt {
  c.expect('keyword', 'def', "expected 'def'");
  const name = c.expect('name', undefined, 'expected a function name').value;
  const typeParams = c.isOp('[') ? parseTypeParams(c) : [];
  c.expect('op', '(', "expected '(' after function name");
  const params = parseParameters(c, ')', true);
  c.expect('op', ')', "expected ')' to close parameters");
  const returns = c.match('op', '->') !== undefined ? parseTest(c) : null;
  const body = parseBlock(c);
  return {
    kind: 'funcdef',
    name,
    typeParams,
    params,
    returns,
    body,
    decorators,
    isAsync,
    span: c.spanFrom(start),
  };
}

function parseClassDef(c: TokenCursor, decorators: readonly Expr[], start: Token = c.peek()): Stmt {
  c.expect('keyword', 'class', "expected 'class'");
  const name = c.expect('name', undefined, 'expected a class name').value;
  const typeParams = c.isOp('[') ? parseTypeParams(c) : [];
  const bases = c.isOp('(') ? parseCallArgs(c) : [];
  const body = parseBlock(c);
  return { kind: 'classdef', name, typeParams, bases, body, decorators, span: c.spanFrom(start) };
}

/** `[T, *Ts, **P, U: bound = default]`. */
function parseTypeParams(c: TokenCursor): TypeParam[] {
  c.expect('op', '[', "expected '['");
  const params: TypeParam[] = [];
  while (!c.isOp(']')) {
    const start = c.peek();
    let kind: TypeParam['kind'] = 'typevar';
    if (c.match('op', '*') !== undefined) kind = 'typevartuple';
    else if (c.match('op', '**') !== undefined) kind = 'paramspec';
    const name = c.expect('name', undefined, 'expected a type parameter name').value;
    const bound = kind === 'typevar' && c.match('op', ':') !== undefined ? parseTest(c) : null;
    const defaultValue = c.match('op', '=') !== undefined ? parseTest(c) : null;
    params.push({ kind, name, bound, default: defaultValue, span: c.spanFrom(start) });
    if (c.match('op', ',') === undefined) break;
  }
  c.expect('op', ']', "expected ']' to close type parameters");
  return params;
}

/** `type NAME [params] = value`. The cursor is on `type`. */
function parseTypeAlias(c: TokenCursor): Stmt {
  const start = c.advance();
  const name = c.expect('name', undefined, 'expected a name for the type alias').value;
  const typeParams = c.isOp('[') ? parseTypeParams(c) : [];
  c.expect('op', '=', "expected '=' in type alias");
  const value = parseTest(c);
  return { kind: 'typealias', name, typeParams, value, span: c.spanFrom(start) };
}

/** `if`/`elif`, with `elif` nested as the single statement of the else branch. */
function parseIf(c: TokenCursor): Stmt {
  const start = c.advance();
  const test = parseNamedExpression(c);
  const body = parseBlock(c);
  let orelse: Stmt[] = [];
  if (c.isKeyword('elif')) orelse = [parseIf(c)];
  else if (c.match('keyword', 'else') !== undefined) orelse = parseBlock(c);
  return { kind: 'if', test, body, orelse, span: c.spanFrom(start) };
}

function parseWhile(c: TokenCursor): Stmt {
  const start = c.advance();
  const test = parseNamedExpression(c);
  const body = parseBlock(c);
  const orelse = c.match('keyword', 'else') !== undefined ? parseBlock(c) : [];
  return { kind: 'while', test, body, orelse, span: c.spanFrom(start) };
}

function parseFor(c: TokenCursor, isAsync: boolean, start: Token = c.peek()): Stmt {
  c.expect('keyword', 'for', "expected 'for'");
  const target = parseTargetList(c);
  checkTarget(target);
  c.expect('keyword', 'in', "expected 'in' in for statement");
  const iter = parseExpressionList(c);
  const body = parseBlock(c);
  const orelse = c.match('keyword', 'else') !== undefined ? parseBlock(c) : [];
  return { kind: 'for', target, iter, body, orelse, isAsync, span: c.spanFrom(start) };
}

function parseWith(c: TokenCursor, isAsync: boolean, start: Token = c.peek()): Stmt {
  c.expect('keyword', 'with', "expected 'with'");
  let items: WithItem[] | null = null;
  if (c.isOp('(')) {
    // `with (a as b, c):` is one form and `with (a) as b:` is another. Try the first, then rewind.
    const mark = c.position();
    try {
      const parenthesized = parseParenthesizedWithItems(c);
      if (c.isOp(':')) items = parenthesized;
    } catch (error) {
      if (!(error instanceof PythonSyntaxError)) throw error;
    }
    if (items === null) c.rewind(mark);
  }
  const resolved = items ?? parseWithItems(c);
  const body = parseBlock(c);
  return { kind: 'with', items: resolved, body, isAsync, span: c.spanFrom(start) };
}

function parseParenthesizedWithItems(c: TokenCursor): WithItem[] {
  c.expect('op', '(', "expected '('");
  const items: WithItem[] = [];
  while (!c.isOp(')')) {
    items.push(parseWithItem(c));
    if (c.match('op', ',') === undefined) break;
  }
  c.expect('op', ')', "expected ')' to close with items");
  return items;
}

function parseWithItems(c: TokenCursor): WithItem[] {
  const items = [parseWithItem(c)];
  while (c.match('op', ',') !== undefined) items.push(parseWithItem(c));
  return items;
}

function parseWithItem(c: TokenCursor): WithItem {
  const context = parseTest(c);
  const target = c.match('keyword', 'as') !== undefined ? parseBitOr(c) : null;
  if (target !== null) checkTarget(target);
  return { context, target };
}

function parseTry(c: TokenCursor): Stmt {
  const start = c.advance();
  const body = parseBlock(c);
  const handlers: ExceptHandler[] = [];
  while (c.isKeyword('except')) {
    const handlerStart = c.advance();
    const isStar = c.match('op', '*') !== undefined;
    let type: Expr | null = null;
    let name: string | null = null;
    if (!c.isOp(':')) {
      type = parseTest(c);
      if (c.match('keyword', 'as') !== undefined) {
        name = c.expect('name', undefined, "expected a name after 'as'").value;
      }
    }
    const handlerBody = parseBlock(c);
    handlers.push({ type, name, isStar, body: handlerBody, span: c.spanFrom(handlerStart) });
  }
  const orelse =
    handlers.length > 0 && c.match('keyword', 'else') !== undefined ? parseBlock(c) : [];
  const hasFinally = c.match('keyword', 'finally') !== undefined;
  const finalbody = hasFinally ? parseBlock(c) : [];
  if (handlers.length === 0 && !hasFinally) c.fail("expected 'except' or 'finally' block");
  return { kind: 'try', body, handlers, orelse, finalbody, span: c.spanFrom(start) };
}

/** `match` is a soft keyword: it starts a match statement only when `:`, a newline, an indent and `case` follow the subject. */
function isMatchStatement(c: TokenCursor): boolean {
  const mark = c.position();
  try {
    c.advance();
    parseExpressionList(c);
    return (
      c.isOp(':') &&
      c.is('newline', undefined, 1) &&
      c.is('indent', undefined, 2) &&
      c.is('name', 'case', 3)
    );
  } catch (error) {
    if (error instanceof PythonSyntaxError) return false;
    throw error;
  } finally {
    c.rewind(mark);
  }
}

function parseMatch(c: TokenCursor): Stmt {
  const start = c.advance();
  const subject = parseExpressionList(c);
  c.expect('op', ':', "expected ':' after match subject");
  c.expect('newline', undefined, 'expected a newline after match subject');
  c.expect('indent', undefined, 'expected an indented block after match');
  const cases: MatchCase[] = [];
  while (c.is('name', 'case')) {
    const caseStart = c.advance();
    const pattern = parsePattern(c);
    const guard = c.match('keyword', 'if') !== undefined ? parseNamedExpression(c) : null;
    const body = parseBlock(c);
    cases.push({ pattern, guard, body, span: c.spanFrom(caseStart) });
  }
  c.expect('dedent', undefined, "expected 'case' in match block");
  return { kind: 'match', subject, cases, span: c.spanFrom(start) };
}
