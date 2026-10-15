import * as ts from 'typescript';
import { unwrapExpression } from './static-keys.js';

const MAX_DEPTH = 6;

/** A configured receiver rule, by identifier name and/or by type name. */
export interface NameTypeRule {
  readonly names?: readonly string[];
  readonly types?: readonly string[];
}

/**
 * Whether a receiver matches a configured rule: its last name is listed, or its type, or a type
 * it derives from or unions, is listed.
 */
export function matchesNameOrType(
  rule: NameTypeRule,
  receiver: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  const name = lastNameOf(receiver);
  if (rule.names && name !== undefined && rule.names.includes(name)) return true;

  if (rule.types) {
    const type = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
    const typeNames = typeNamesOf(type, checker, 0);
    if (rule.types.some((typeName) => typeNames.has(typeName))) return true;
  }
  return false;
}

function lastNameOf(expression: ts.Expression): string | undefined {
  const node = unwrapExpression(expression);
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

/** The names a type is known by: itself, its alias, its base types, and union members. */
function typeNamesOf(type: ts.Type, checker: ts.TypeChecker, depth: number): Set<string> {
  const names = new Set<string>();
  if (depth > MAX_DEPTH) return names;

  const own = type.aliasSymbol?.getName();
  if (own) names.add(own);
  const symbolName = type.getSymbol()?.getName();
  if (symbolName) names.add(symbolName);

  if (type.isUnion()) {
    for (const member of type.types) {
      for (const name of typeNamesOf(member, checker, depth + 1)) names.add(name);
    }
  } else if (type.isClassOrInterface()) {
    for (const base of checker.getBaseTypes(type)) {
      for (const name of typeNamesOf(base, checker, depth + 1)) names.add(name);
    }
  }
  return names;
}
