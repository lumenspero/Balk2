import * as ts from 'typescript';
import { ownerIdOf, type OwnerScope } from '../facts/owner-rule.js';

/**
 * Owner ids for JS/TS (Phase 2.6, D6). The naming rule lives in `facts/owner-rule.ts`, shared by
 * every front end. This file reads the TypeScript AST only to find the scopes around a node.
 */

/** Source-order numbers for anonymous object literals, per file: `<anonymous>#1`, `<anonymous>#2`. */
const anonymousNumbers = new WeakMap<ts.SourceFile, Map<ts.ObjectLiteralExpression, number>>();

/**
 * The graph symbol id that owns the code inside `node`, when `node` starts a new owner:
 * a named function or class, a method of a named class or of an object literal, or a variable
 * holding a function expression.
 */
export function ownerOf(node: ts.Node, filePath: string): string | undefined {
  const scope = scopeStartedBy(node);
  if (!scope) return undefined;
  return ownerIdOf(filePath, [...enclosingScopes(node), scope]);
}

/**
 * The nearest owner enclosing `node` (including `node` itself), or the file path for
 * file-level code.
 */
export function enclosingOwner(node: ts.Node, filePath: string): string {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const owner = ownerOf(current, filePath);
    if (owner) return owner;
  }
  return filePath;
}

/** The owner scope `node` starts, if it starts one. */
function scopeStartedBy(node: ts.Node): OwnerScope | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return { kind: 'function', name: node.name.text };
  }
  if (ts.isClassDeclaration(node) && node.name) {
    return { kind: 'class', name: node.name.text };
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && hasNamedContainer(node)) {
    return { kind: 'method', name: node.name.text };
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return { kind: 'function-variable', name: node.name.text };
  }
  return undefined;
}

/** The scopes around `node`, outermost first. Only scopes that can qualify a name are included. */
function enclosingScopes(node: ts.Node): OwnerScope[] {
  const scopes: OwnerScope[] = [];
  for (let current = node.parent; current; current = current.parent) {
    const scope = scopeStartedBy(current) ?? objectScope(current);
    if (scope) scopes.unshift(scope);
  }
  return scopes;
}

/** A method is an owner when its container is a named class or an object literal. */
function hasNamedContainer(method: ts.MethodDeclaration): boolean {
  const parent = method.parent;
  if (ts.isObjectLiteralExpression(parent)) return true;
  return ts.isClassDeclaration(parent) && parent.name !== undefined;
}

/** An object literal as a qualifier: named by its variable, or `<anonymous>#n` otherwise. */
function objectScope(node: ts.Node): OwnerScope | undefined {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  const variable = namedVariableOf(node);
  if (variable) return { kind: 'object', name: variable };
  return { kind: 'object', name: `<anonymous>#${anonymousNumber(node)}` };
}

/** The variable name of `const api = { ... }`, or undefined for any other object literal. */
function namedVariableOf(literal: ts.ObjectLiteralExpression): string | undefined {
  const parent = literal.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    ts.isIdentifier(parent.name) &&
    parent.initializer === literal
  ) {
    return parent.name.text;
  }
  return undefined;
}

/** The source-order number of an anonymous object literal within its file, starting at 1. */
function anonymousNumber(literal: ts.ObjectLiteralExpression): number {
  const sourceFile = literal.getSourceFile();
  let numbers = anonymousNumbers.get(sourceFile);
  if (!numbers) {
    const computed = new Map<ts.ObjectLiteralExpression, number>();
    let next = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node) && namedVariableOf(node) === undefined) {
        next += 1;
        computed.set(node, next);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    anonymousNumbers.set(sourceFile, computed);
    numbers = computed;
  }
  return numbers.get(literal) ?? 0;
}
