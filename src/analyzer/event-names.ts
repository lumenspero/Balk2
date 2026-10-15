import * as ts from 'typescript';
import type { Evidence } from '../types.js';
import {
  declarationOf,
  isConst,
  resolveStaticKey,
  unwrapExpression,
  type KeySource,
} from './static-keys.js';

export { unwrapExpression } from './static-keys.js';

/** How a static event name was found: a string key, or the name of an event object. */
export type EventNameSource = KeySource | 'event-object';

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

/** Read the event name from the argument of a name-style protocol (`bus.emit('ready')`). */
export function resolveEventName(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): EventNameResolution {
  return resolveStaticKey(expression, checker);
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
