import * as ts from 'typescript';

/**
 * The graph symbol id that owns the code inside `node`, when `node` starts a new owner:
 * a named function or class, a method, or a variable holding a function expression.
 */
export function ownerOf(node: ts.Node, filePath: string): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return `${filePath}:${node.name.text}`;
  if (ts.isClassDeclaration(node) && node.name) return `${filePath}:${node.name.text}`;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    const className = getParentClassName(node);
    if (className) return `${filePath}:${className}.${node.name.text}`;
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return `${filePath}:${node.name.text}`;
  }
  return undefined;
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

function getParentClassName(node: ts.MethodDeclaration): string | undefined {
  if (node.parent && ts.isClassDeclaration(node.parent) && node.parent.name) {
    return node.parent.name.text;
  }
  return undefined;
}
