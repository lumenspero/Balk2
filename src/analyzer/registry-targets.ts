import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import { ownerOf } from './owner.js';
import type { PathLookup } from './repository-files.js';
import { unwrapExpression } from './static-keys.js';

export /**
 * The graph symbol a registered value names (`User`, `this.handler`, a function): the same
 * ownership rule the listener pass uses, so the id matches the symbol node. Classes are valid
 * targets here, unlike listeners. Anything else (a parameter, a literal, a call) is `undefined`.
 */
function symbolTargetOf(
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

  const id = ownerOf(declaration, filePath);
  return id !== undefined && graph.hasSymbol(id) ? id : undefined;
}
