import * as ts from 'typescript';
import { unwrapExpression } from './event-names.js';

/** Boolean listener flags that are statically known to be set. */
export type ListenerFlags = Readonly<
  Partial<Record<'once' | 'capture' | 'passive' | 'abortable', true>>
>;

const MAX_DEPTH = 4;

/**
 * Read the lifecycle flags a listener-options argument sets:
 *
 * - `once`: removed after the first event.
 * - `capture`: registered for the capture phase (also the legacy `true` third argument).
 * - `passive`: promises not to prevent the default action.
 * - `abortable`: has a `signal`, so it is removed when that signal aborts.
 *
 * Only flags known to be `true` are returned: a missing flag means "not known to be set", so a
 * dynamic option never produces a false claim. Unsubscription only has `capture`, because
 * that is the one option that decides which registration is removed.
 */
export function readListenerOptions(
  argument: ts.Expression | undefined,
  checker: ts.TypeChecker,
  direction: 'subscribe' | 'unsubscribe',
): ListenerFlags {
  if (!argument) return {};

  const literal = booleanOf(argument, checker, 0);
  if (literal !== undefined) return literal ? { capture: true } : {};

  const options = objectLiteralOf(argument, checker, 0);
  if (!options) return {};

  const flags: Partial<Record<'once' | 'capture' | 'passive' | 'abortable', true>> = {};
  for (const property of options.properties) {
    const key = keyOf(property);
    if (key === undefined) continue;

    if (key === 'signal') {
      if (direction === 'subscribe' && hasValue(property, checker)) flags.abortable = true;
      continue;
    }
    if (key !== 'once' && key !== 'capture' && key !== 'passive') continue;
    if (direction === 'unsubscribe' && key !== 'capture') continue;

    const value = ts.isPropertyAssignment(property)
      ? booleanOf(property.initializer, checker, 0)
      : ts.isShorthandPropertyAssignment(property)
        ? booleanOfSymbol(
            resolveAlias(checker.getShorthandAssignmentValueSymbol(property), checker),
            checker,
            0,
          )
        : undefined;
    if (value === true) flags[key] = true;
  }
  return flags;
}

/** The object literal an options argument is, directly or through a `const` binding. */
function objectLiteralOf(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  depth: number,
): ts.ObjectLiteralExpression | undefined {
  const node = unwrapExpression(expression);
  if (ts.isObjectLiteralExpression(node)) return node;
  if (depth >= MAX_DEPTH || !ts.isIdentifier(node)) return undefined;

  const symbol = symbolOf(node, checker);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  return declaration &&
    ts.isVariableDeclaration(declaration) &&
    isConst(declaration) &&
    declaration.initializer
    ? objectLiteralOf(declaration.initializer, checker, depth + 1)
    : undefined;
}

/** `true` or `false` when statically known, through literals, const bindings and declared types. */
function booleanOf(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  depth: number,
): boolean | undefined {
  const node = unwrapExpression(expression);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (!(ts.isIdentifier(node) || ts.isPropertyAccessExpression(node))) return undefined;

  return booleanOfSymbol(symbolOf(node, checker), checker, depth);
}

/**
 * The value of a binding: its `const` initializer when it has one, else its *declared* type.
 * The type at the point of use is not enough: `let flag = true` is narrowed to `true` right
 * after the assignment, yet the binding is mutable.
 */
function booleanOfSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
  depth: number,
): boolean | undefined {
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!symbol || !declaration || depth >= MAX_DEPTH) return undefined;

  if (ts.isVariableDeclaration(declaration) && isConst(declaration) && declaration.initializer) {
    const followed = booleanOf(declaration.initializer, checker, depth + 1);
    if (followed !== undefined) return followed;
  }

  const declared = checker.typeToString(checker.getTypeOfSymbolAtLocation(symbol, declaration));
  return declared === 'true' ? true : declared === 'false' ? false : undefined;
}

/** A `signal` option counts unless it is literally `undefined` or `null`. */
function hasValue(property: ts.ObjectLiteralElementLike, checker: ts.TypeChecker): boolean {
  if (ts.isShorthandPropertyAssignment(property)) return true;
  if (!ts.isPropertyAssignment(property)) return false;

  const value = unwrapExpression(property.initializer);
  if (value.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isIdentifier(value) && value.text === 'undefined') return false;
  return checker.typeToString(checker.getTypeAtLocation(value)) !== 'undefined';
}

function keyOf(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
    return undefined;
  }
  const name = property.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

function symbolOf(
  node: ts.Identifier | ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  return resolveAlias(
    checker.getSymbolAtLocation(ts.isIdentifier(node) ? node : node.name),
    checker,
  );
}

function resolveAlias(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  return symbol && symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
}

function isConst(declaration: ts.VariableDeclaration): boolean {
  return (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0;
}
