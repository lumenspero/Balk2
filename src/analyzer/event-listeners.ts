import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import { unwrapExpression } from './event-names.js';
import { ownerOf } from './owner.js';
import { createPathLookup, type PathLookup } from './repository-files.js';
import type { RepositoryProgram } from './repository-program.js';

/**
 * Finds the graph symbol behind a listener argument, so a subscription can be attributed to
 * the function that reacts to the event instead of the code that registered it.
 */
export class ListenerResolver {
  private readonly pathOf: PathLookup;
  private readonly checker: ts.TypeChecker;

  constructor(
    repository: RepositoryProgram,
    private readonly graph: ConnectionGraph,
  ) {
    this.checker = repository.checker;
    this.pathOf = createPathLookup(repository);
  }

  /**
   * The symbol id of a named function, function-valued variable or method passed as a
   * listener (`onReady`, `this.onReady`, `onReady.bind(this)`), when that symbol is in the
   * graph. Inline callbacks, parameters and anything unresolved return `undefined`.
   */
  ownerOf(argument: ts.Expression | undefined): string | undefined {
    if (!argument) return undefined;

    let node = unwrapExpression(argument);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'bind'
    ) {
      node = unwrapExpression(node.expression.expression);
    }

    const nameNode = ts.isIdentifier(node)
      ? node
      : ts.isPropertyAccessExpression(node)
        ? node.name
        : undefined;
    if (!nameNode) return undefined;

    let symbol = this.checker.getSymbolAtLocation(nameNode);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }

    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
    if (!declaration) return undefined;

    const sourceFile = declaration.getSourceFile();
    const filePath = this.pathOf(sourceFile);
    if (filePath === undefined || sourceFile.isDeclarationFile) return undefined;

    const id = ts.isClassDeclaration(declaration)
      ? undefined
      : (ownerOf(declaration, filePath) ?? functionValuedClassProperty(declaration, filePath));
    return id !== undefined && this.graph.hasSymbol(id) ? id : undefined;
  }
}

/** `class A { onReady = () => {} }` */
function functionValuedClassProperty(
  declaration: ts.Declaration,
  filePath: string,
): string | undefined {
  if (
    ts.isPropertyDeclaration(declaration) &&
    ts.isIdentifier(declaration.name) &&
    ts.isClassDeclaration(declaration.parent) &&
    declaration.parent.name &&
    declaration.initializer &&
    (ts.isArrowFunction(declaration.initializer) ||
      ts.isFunctionExpression(declaration.initializer))
  ) {
    return `${filePath}:${declaration.parent.name.text}.${declaration.name.text}`;
  }
  return undefined;
}
