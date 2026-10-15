import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import { ownerOf } from './owner.js';
import type { PathLookup } from './repository-files.js';
import { unwrapExpression } from './static-keys.js';

/**
 * The graph symbol a registered value names (`User`, `this.handler`, a top-level function), or
 * `undefined` when it names nothing the graph can point at.
 *
 * A value must be declared at the top level of a repository file, or as a class member. A local
 * variable, a parameter, or a function nested inside another function has no symbol of its own,
 * so it is not a target. Without this rule a local would be given a symbol id built from its
 * name, which could match an unrelated top-level symbol or the enclosing function.
 */
export function symbolTargetOf(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  graph: ConnectionGraph,
  pathOf: PathLookup,
): string | undefined {
  const node = unwrapExpression(expression);
  const nameNode = ts.isIdentifier(node)
    ? node
    : ts.isPropertyAccessExpression(node)
      ? node.name
      : undefined;
  if (!nameNode) return undefined;

  let symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }

  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return undefined;

  const sourceFile = declaration.getSourceFile();
  const filePath = pathOf(sourceFile);
  if (filePath === undefined || sourceFile.isDeclarationFile) return undefined;
  if (isNestedInFunction(declaration)) return undefined;

  const id = ownerOf(declaration, filePath);
  return id !== undefined && graph.hasSymbol(id) ? id : undefined;
}

/**
 * True when a declaration sits inside a function body or parameter list before reaching the file
 * or a class. Class members and top-level declarations are not nested; locals, parameters and
 * nested functions are.
 */
function isNestedInFunction(declaration: ts.Declaration): boolean {
  for (let current = declaration.parent; current; current = current.parent) {
    if (ts.isSourceFile(current) || ts.isClassLike(current)) return false;
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return true;
    }
  }
  return false;
}
