import * as ts from 'typescript';
import type { Evidence } from '../types.js';

/** How a static event name was found. */
export type EventNameSource =
  | 'literal'
  | 'template'
  | 'concatenation'
  | 'const-binding'
  | 'object-constant'
  | 'enum-member'
  | 'literal-type'
  | 'event-object';

/**
 * The outcome of reading an event name from an argument.
 *
 * - `static`: the name is known.
 * - `dynamic`: the argument is (or may be) a string, but its value is not statically known.
 *   The call looks like an event call, so it is worth an unresolved observation.
 * - `not-a-name`: the argument cannot be an event name at all (an object, a number, a
 *   function), so the call is some other convention and is skipped silently.
 */
export type EventNameResolution =
  | {
      readonly kind: 'static';
      readonly name: string;
      readonly via: EventNameSource;
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
      readonly via: EventNameSource;
      readonly evidence: Evidence;
    }
  | { readonly ok: false; readonly reason: string; readonly circular?: true };

/** Read the event name from the argument of a name-style protocol (`bus.emit('ready')`). */
export function resolveEventName(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): EventNameResolution {
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

/**
 * Read the event name from an event object argument (`target.dispatchEvent(event)`): a
 * `new Event('x')`, `new CustomEvent('x', ...)` or any `Event` subclass, directly or through
 * a const binding.
 */
export function resolveEventObject(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): EventNameResolution {
  return evaluateEventObject(expression, checker, new Set(), 0);
}

function evaluateEventObject(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Node>,
  depth: number,
): EventNameResolution {
  const node = unwrapExpression(expression);
  if (depth > MAX_DEPTH)
    return { kind: 'dynamic', reason: 'event object reference chain too deep' };

  if (ts.isNewExpression(node)) {
    if (!isEventConstructor(node, checker)) {
      return { kind: 'dynamic', reason: 'not a recognized event constructor' };
    }
    const nameArgument = node.arguments?.[0];
    if (!nameArgument) return { kind: 'dynamic', reason: 'event has no name argument' };

    const resolved = resolveEventName(nameArgument, checker);
    if (resolved.kind === 'static') return { ...resolved, via: 'event-object' };
    return {
      kind: 'dynamic',
      reason:
        resolved.kind === 'dynamic'
          ? `event name: ${resolved.reason}`
          : 'event name argument is not a string',
    };
  }

  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    const declaration = declarationOf(node, checker);
    if (declaration && ts.isVariableDeclaration(declaration)) {
      if (seen.has(declaration)) return { kind: 'dynamic', reason: 'circular event binding' };
      seen.add(declaration);
      if (!declaration.initializer) {
        return { kind: 'dynamic', reason: 'event object is not statically known' };
      }
      if (!isConst(declaration)) {
        return { kind: 'dynamic', reason: 'event object is a mutable binding' };
      }
      return evaluateEventObject(declaration.initializer, checker, seen, depth + 1);
    }
    return { kind: 'dynamic', reason: 'event object is not statically known' };
  }

  return { kind: 'dynamic', reason: 'event object is a computed expression' };
}

function isEventConstructor(node: ts.NewExpression, checker: ts.TypeChecker): boolean {
  if (ts.isIdentifier(node.expression)) {
    const constructorName = node.expression.text;
    if (constructorName === 'Event' || constructorName === 'CustomEvent') return true;
  }
  return inheritsFromEvent(checker.getTypeAtLocation(node), checker, 0);
}

function inheritsFromEvent(type: ts.Type, checker: ts.TypeChecker, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (type.getSymbol()?.getName() === 'Event') return true;
  if (!type.isClassOrInterface()) return false;
  return checker.getBaseTypes(type).some((base) => inheritsFromEvent(base, checker, depth + 1));
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

  // A literal type is a compiler-checked guarantee, e.g. `declare const X: 'ready'` or a
  // parameter typed `'ready'`.
  const type = checker.getTypeAtLocation(node);
  if (type.isStringLiteral()) {
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
function reattribute(result: Evaluated, via: EventNameSource): Evaluated {
  if (!result.ok) return result;
  return { ...result, via: result.via === 'literal' ? via : result.via, evidence: 'ts-program' };
}

function classifyUnresolved(
  node: ts.Expression,
  checker: ts.TypeChecker,
  reason: string,
): EventNameResolution {
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
function declarationOf(
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

function describeReference(node: ts.Expression): string {
  return ts.isIdentifier(node) ? `"${node.text}" is not a constant` : 'reference is not a constant';
}

function isConst(declaration: ts.VariableDeclaration): boolean {
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
