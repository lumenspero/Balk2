import * as ts from 'typescript';
import type { Evidence } from '../types.js';

/** How a static string key was found. */
export type KeySource =
  | 'literal'
  | 'template'
  | 'concatenation'
  | 'const-binding'
  | 'object-constant'
  | 'enum-member'
  | 'literal-type';

/**
 * The outcome of reading a string key from an expression.
 *
 * - `static`: the key is known.
 * - `dynamic`: the argument is (or may be) a string, but its value is not statically known.
 * - `not-a-name`: the argument cannot be a string key at all (an object, a number, a function).
 */
export type KeyResolution =
  | {
      readonly kind: 'static';
      readonly name: string;
      readonly via: KeySource;
      readonly evidence: Evidence;
    }
  | { readonly kind: 'dynamic'; readonly reason: string }
  | { readonly kind: 'not-a-name' };

const MAX_DEPTH = 8;

type Evaluated =
  | {
      readonly ok: true;
      readonly value: string;
      /** Distinguishes `'a' + 1` (a string) from `1 + 1` (a number). */
      readonly isString: boolean;
      readonly via: KeySource;
      readonly evidence: Evidence;
    }
  | { readonly ok: false; readonly reason: string; readonly circular?: true };

/**
 * Read a string key from an expression: a literal, template, concatenation, constant,
 * object-constant, enum member or declared literal type. Shared by event names and any other
 * string-key protocol.
 */
export function resolveStaticKey(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): KeyResolution {
  const node = unwrapExpression(expression);
  if (ts.isNumericLiteral(node)) return { kind: 'not-a-name' };

  const result = evaluate(node, checker, new Set(), 0);
  if (result.ok) {
    return result.isString
      ? { kind: 'static', name: result.value, via: result.via, evidence: result.evidence }
      : { kind: 'not-a-name' };
  }
  return classifyUnresolved(node, checker, result.reason);
}

function evaluate(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>,
  depth: number,
): Evaluated {
  const node = unwrapExpression(expression);
  if (depth > MAX_DEPTH) return { ok: false, reason: 'reference chain too deep' };

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { ok: true, value: node.text, isString: true, via: 'literal', evidence: 'ast' };
  }

  if (ts.isNumericLiteral(node)) {
    return {
      ok: true,
      value: String(Number(node.text)),
      isString: false,
      via: 'literal',
      evidence: 'ast',
    };
  }

  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    let evidence: Evidence = 'ast';
    for (const span of node.templateSpans) {
      const part = evaluate(span.expression, checker, seen, depth + 1);
      if (!part.ok) return part;
      value += part.value + span.literal.text;
      if (part.evidence === 'ts-program') evidence = 'ts-program';
    }
    return { ok: true, value, isString: true, via: 'template', evidence };
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = evaluate(node.left, checker, seen, depth + 1);
    if (!left.ok) return left;
    const right = evaluate(node.right, checker, seen, depth + 1);
    if (!right.ok) return right;
    if (!left.isString && !right.isString) {
      return { ok: false, reason: 'numeric addition, not a string' };
    }
    return {
      ok: true,
      value: left.value + right.value,
      isString: true,
      via: 'concatenation',
      evidence:
        left.evidence === 'ts-program' || right.evidence === 'ts-program' ? 'ts-program' : 'ast',
    };
  }

  if (
    ts.isIdentifier(node) ||
    ts.isPropertyAccessExpression(node) ||
    (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
  ) {
    return evaluateReference(node, checker, seen, depth);
  }

  return { ok: false, reason: 'computed expression' };
}

function evaluateReference(
  node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>,
  depth: number,
): Evaluated {
  const declaration = declarationOf(node, checker);

  if (declaration) {
    if (seen.has(declaration)) {
      return { ok: false, reason: 'circular constant', circular: true };
    }
    seen.add(declaration);

    const followed = evaluateDeclaration(declaration, checker, seen, depth);
    if (followed.ok || followed.circular) return followed;
  }

  // A *declared* literal type is a compiler-checked guarantee, e.g. `declare const X: 'ready'`
  // or a parameter typed `'ready'`. The type at the point of use is not: `let k: 'a' | 'b' = 'a'`
  // is narrowed to `'a'` right after the assignment, yet the binding is mutable.
  const type = declaredTypeOf(node, checker);
  if (type?.isStringLiteral()) {
    return {
      ok: true,
      value: type.value,
      isString: true,
      via: 'literal-type',
      evidence: 'ts-program',
    };
  }

  return { ok: false, reason: describeReference(node) };
}

function evaluateDeclaration(
  declaration: ts.Declaration,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>,
  depth: number,
): Evaluated {
  if (ts.isVariableDeclaration(declaration)) {
    if (!declaration.initializer) return { ok: false, reason: 'binding has no initializer' };
    if (!isConst(declaration)) return { ok: false, reason: 'mutable binding' };
    return reattribute(
      evaluate(declaration.initializer, checker, seen, depth + 1),
      'const-binding',
    );
  }

  if (ts.isPropertyAssignment(declaration)) {
    return reattribute(
      evaluate(declaration.initializer, checker, seen, depth + 1),
      'object-constant',
    );
  }

  if (ts.isShorthandPropertyAssignment(declaration)) {
    const target = checker.getShorthandAssignmentValueSymbol(declaration)?.declarations?.[0];
    return target
      ? reattribute(evaluateDeclaration(target, checker, seen, depth + 1), 'object-constant')
      : { ok: false, reason: 'shorthand property has no value' };
  }

  if (ts.isPropertyDeclaration(declaration)) {
    const readonly = declaration.modifiers?.some((m) => m.kind === ts.SyntaxKind.ReadonlyKeyword);
    if (!readonly || !declaration.initializer) {
      return { ok: false, reason: 'class property is not a readonly constant' };
    }
    return reattribute(
      evaluate(declaration.initializer, checker, seen, depth + 1),
      'object-constant',
    );
  }

  if (ts.isEnumMember(declaration)) {
    const value = checker.getConstantValue(declaration);
    return typeof value === 'string'
      ? { ok: true, value, isString: true, via: 'enum-member', evidence: 'ts-program' }
      : { ok: false, reason: 'enum member is not a string' };
  }

  return { ok: false, reason: 'not a constant declaration' };
}

/** A name read through a declaration is a compiler-resolved reference, not a bare literal. */
function reattribute(result: Evaluated, via: KeySource): Evaluated {
  if (!result.ok) return result;
  return { ...result, via: result.via === 'literal' ? via : result.via, evidence: 'ts-program' };
}

function classifyUnresolved(
  node: ts.Expression,
  checker: ts.TypeChecker,
  reason: string,
): KeyResolution {
  if (
    ts.isObjectLiteralExpression(node) ||
    ts.isArrayLiteralExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassExpression(node) ||
    ts.isNewExpression(node) ||
    ts.isBigIntLiteral(node) ||
    ts.isRegularExpressionLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return { kind: 'not-a-name' };
  }

  const type = checker.getTypeAtLocation(node);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) {
    return { kind: 'dynamic', reason };
  }
  return isStringLike(type) ? { kind: 'dynamic', reason } : { kind: 'not-a-name' };
}

function isStringLike(type: ts.Type): boolean {
  if (type.flags & ts.TypeFlags.StringLike) return true;
  if (type.isUnionOrIntersection()) return type.types.some(isStringLike);
  return false;
}

/** The declaration an identifier or property access refers to, following import aliases. */
export function declarationOf(
  node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: ts.TypeChecker,
): ts.Declaration | undefined {
  let symbol = ts.isIdentifier(node)
    ? checker.getSymbolAtLocation(node)
    : ts.isPropertyAccessExpression(node)
      ? checker.getSymbolAtLocation(node.name)
      : checker.getSymbolAtLocation(node.argumentExpression);

  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
}

/** The type a binding or property is declared with, ignoring narrowing at the use site. */
function declaredTypeOf(
  node: ts.Identifier | ts.PropertyAccessExpression | ts.ElementAccessExpression,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  let symbol = ts.isIdentifier(node)
    ? checker.getSymbolAtLocation(node)
    : ts.isPropertyAccessExpression(node)
      ? checker.getSymbolAtLocation(node.name)
      : checker.getSymbolAtLocation(node.argumentExpression);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);

  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return symbol && declaration ? checker.getTypeOfSymbolAtLocation(symbol, declaration) : undefined;
}

function describeReference(node: ts.Expression): string {
  return ts.isIdentifier(node) ? `"${node.text}" is not a constant` : 'reference is not a constant';
}

export function isConst(declaration: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}

/** Look through parentheses, non-null assertions, `as`, `satisfies` and type assertions. */
export function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  for (;;) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
}
