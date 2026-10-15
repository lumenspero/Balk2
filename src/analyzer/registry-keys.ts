import * as ts from 'typescript';
import type { Evidence, RegistryKeyType } from '../types.js';
import type { RegistryContainer } from './registry-receivers.js';
import { resolveStaticKey, unwrapExpression, type KeySource } from './static-keys.js';

/**
 * The outcome of reading a registry key from an argument.
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
      readonly via: KeySource | 'numeric-literal';
      readonly evidence: Evidence;
    }
  | { readonly kind: 'dynamic'; readonly reason: string }
  | { readonly kind: 'not-a-name' };

/**
 * Read a registry key. Unlike an event name, a registry key may be a number: a numeric literal is
 * a key in any registry.
 *
 * - In a dictionary (`object`), JavaScript turns the number into a string, so `404` is the key
 *   `'404'`, stored as a string.
 * - In a typed registry (Map, Set, class), `404` and `'404'` are different keys, so the number is
 *   stored as `number`.
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
