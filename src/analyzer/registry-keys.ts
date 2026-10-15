import * as ts from 'typescript';
import type { Evidence, RegistryKeyType } from '../types.js';
import type { RegistryContainer } from './registry-receivers.js';
import { resolveStaticKey, unwrapExpression, type KeySource } from './static-keys.js';

/**
 * The outcome of reading a registry key from an argument or a type argument.
 *
 * - `static`: the key is known, with the type it is stored under.
 * - `dynamic`: the argument is (or may be) a key, but its value is not statically known.
 * - `not-a-name`: the argument cannot be a key at all (an object, a function), so the call is
 *   some other convention and is skipped silently.
 */
export type RegistryKeyResolution =
  | {
      readonly kind: 'static';
      readonly name: string;
      readonly keyType: RegistryKeyType;
      readonly via: KeySource | 'numeric-literal' | 'class-token' | 'type-argument';
      readonly evidence: Evidence;
    }
  | { readonly kind: 'dynamic'; readonly reason: string }
  | { readonly kind: 'not-a-name' };

/**
 * Read a registry key from an argument. A registry key may be a number, a string, or a class used
 * as a token.
 *
 * - In a dictionary (`object`), JavaScript turns a number into a string, so `404` is the key
 *   `'404'`. A class token has no stable string form there, so it is not a key.
 * - In a typed registry (Map, Set, class), `404` and `'404'` are different keys, so the number is
 *   stored as `number`. A class reference is stored as `type`, keyed by the class name.
 *
 * Numbers held in constants (`const CODE = 404`) are not read yet; they resolve as not-a-name.
 */
export function resolveRegistryKey(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  container: RegistryContainer,
): RegistryKeyResolution {
  const numeric = numericLiteralValue(unwrapExpression(expression));
  if (numeric !== undefined) {
    return {
      kind: 'static',
      name: numeric,
      keyType: container === 'object' ? 'string' : 'number',
      via: 'numeric-literal',
      evidence: 'ast',
    };
  }

  const token = classTokenName(expression, checker);
  if (token !== undefined) {
    if (container === 'object') return { kind: 'not-a-name' };
    return {
      kind: 'static',
      name: token,
      keyType: 'type',
      via: 'class-token',
      evidence: 'ts-program',
    };
  }

  const resolved = resolveStaticKey(expression, checker);
  if (resolved.kind !== 'static') return resolved;
  return {
    kind: 'static',
    name: resolved.name,
    keyType: 'string',
    via: resolved.via,
    evidence: resolved.evidence,
  };
}

/**
 * Read a key from a type argument, as in `container.resolve<UserService>()`. The key is the class
 * named by the type, stored as a class token, so it agrees with `container.register(UserService, …)`.
 *
 * A type argument that is not a named class (a generic `T`, a union, a primitive) cannot be read
 * as a token, so it is dynamic: the lookup is reported rather than guessed.
 */
export function resolveTypeArgumentKey(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  container: RegistryContainer,
): RegistryKeyResolution {
  if (!ts.isTypeReferenceNode(typeNode) || !ts.isIdentifier(typeNode.typeName)) {
    return { kind: 'dynamic', reason: 'type argument is not a named type' };
  }

  const name = classNameOf(typeNode.typeName, checker);
  if (name === undefined) {
    return { kind: 'dynamic', reason: `type argument "${typeNode.typeName.text}" is not a class` };
  }
  if (container === 'object') return { kind: 'not-a-name' };
  return { kind: 'static', name, keyType: 'type', via: 'type-argument', evidence: 'ts-program' };
}

/** The class name a bare identifier or `Namespace.Class` refers to, when it is a class. */
function classTokenName(expression: ts.Expression, checker: ts.TypeChecker): string | undefined {
  const node = unwrapExpression(expression);
  const identifier = ts.isIdentifier(node)
    ? node
    : ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)
      ? node.name
      : undefined;
  return identifier ? classNameOf(identifier, checker) : undefined;
}

/** The name of the class an identifier refers to, following import aliases, or undefined. */
function classNameOf(identifier: ts.Identifier, checker: ts.TypeChecker): string | undefined {
  let symbol = checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration && ts.isClassDeclaration(declaration) && declaration.name
    ? declaration.name.text
    : undefined;
}

/** The canonical text of a numeric literal, optionally negated: `404`, `0x19C` and `-1`. */
function numericLiteralValue(node: ts.Expression): string | undefined {
  if (ts.isNumericLiteral(node)) return String(Number(node.text));
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return `-${String(Number(node.operand.text))}`;
  }
  return undefined;
}
