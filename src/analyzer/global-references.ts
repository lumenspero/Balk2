import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import {
  getStaticPropertyChain,
  locationOf,
  type GlobalFact,
  type GlobalLookup,
  type GlobalSymbol,
  type GlobalSymbolIndex,
} from './global-symbols.js';
import type { RepositoryProgram } from './repository-program.js';

type UseKind = 'read' | 'write' | 'delete';

/**
 * Resolution pass: walk one file and relate its uses of globals to the global index.
 *
 * Reads and deletes of a unique target become `references` edges (symbol-level and
 * file-level). Every use, including writes and ambiguous ones, is also returned as an
 * independent {@link GlobalFact}; ambiguous uses carry their candidate origins at low
 * confidence and never produce an edge.
 */
export function collectGlobalReferences(
  sourceFile: ts.SourceFile,
  fromFile: string,
  repository: RepositoryProgram,
  globalSymbols: GlobalSymbolIndex,
  graph: ConnectionGraph,
): GlobalFact[] {
  const facts: GlobalFact[] = [];
  const emitted = new Set<string>();

  const addReference = (owner: string, target: GlobalSymbol): void => {
    if (target.filePath === fromFile) return;

    const symbolKey = `references:${owner}:${target.symbolId}`;
    if (!emitted.has(symbolKey)) {
      graph.addRelationship('references', owner, target.symbolId);
      emitted.add(symbolKey);
    }

    const fileKey = `references:${fromFile}:${target.filePath}`;
    if (!emitted.has(fileKey)) {
      graph.addRelationship('references', fromFile, target.filePath);
      emitted.add(fileKey);
    }
  };

  const record = (name: string, node: ts.Expression, owner: string, lookup: GlobalLookup): void => {
    if (lookup.kind === 'none') return;

    const location = locationOf(node, fromFile);
    for (const use of classifyUse(node)) {
      if (lookup.kind === 'ambiguous') {
        facts.push({
          kind: use,
          name,
          location,
          owner,
          resolution: 'ambiguous',
          confidence: 'low',
          candidates: lookup.candidates.map((candidate) => candidate.symbolId).sort(),
        });
        continue;
      }

      facts.push({
        kind: use,
        name,
        location,
        owner,
        resolution: lookup.kind,
        confidence: 'high',
        targetSymbolId: lookup.symbol.symbolId,
      });
      if (use !== 'write') addReference(owner, lookup.symbol);
    }
  };

  const visit = (node: ts.Node, currentOwner?: string): void => {
    const owner = ownerOf(node, fromFile) ?? currentOwner;

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const declared = globalSymbols.declaredAt(node);
      if (declared) {
        // The site that establishes the global is a declaration, not a use of it.
        facts.push({
          kind: 'declare',
          name: declared.name,
          location: locationOf(node, fromFile),
          owner: owner ?? fromFile,
          resolution: 'resolved',
          confidence: 'high',
          targetSymbolId: declared.symbolId,
        });
      } else {
        const name = getGlobalReferenceName(node, repository, globalSymbols);
        if (name) record(name, node, owner ?? fromFile, globalSymbols.lookup(name));
      }
    } else if (ts.isIdentifier(node) && isIdentifierPosition(node)) {
      const symbol = repository.checker.getSymbolAtLocation(node);
      const lookup = symbol
        ? globalSymbols.lookupTypeScriptSymbol(symbol)
        : globalSymbols.lookup(node.text);
      record(node.text, node, owner ?? fromFile, lookup);
    }

    ts.forEachChild(node, (child) => visit(child, owner));
  };

  visit(sourceFile);

  return facts.sort(
    (a, b) =>
      a.location.line - b.location.line ||
      a.location.column - b.location.column ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0),
  );
}

/** The symbol id that owns code inside `node`, when `node` starts a new owner. */
function ownerOf(node: ts.Node, fromFile: string): string | undefined {
  if (ts.isFunctionDeclaration(node) && node.name) return `${fromFile}:${node.name.text}`;
  if (ts.isClassDeclaration(node) && node.name) return `${fromFile}:${node.name.text}`;
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
    const className = getParentClassName(node);
    if (className) return `${fromFile}:${className}.${node.name.text}`;
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return `${fromFile}:${node.name.text}`;
  }
  return undefined;
}

function getParentClassName(node: ts.MethodDeclaration): string | undefined {
  if (node.parent && ts.isClassDeclaration(node.parent) && node.parent.name) {
    return node.parent.name.text;
  }
  return undefined;
}

function getGlobalReferenceName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  repository: RepositoryProgram,
  globalSymbols: GlobalSymbolIndex,
): string | undefined {
  const chain = getStaticPropertyChain(node);
  if (!chain) return undefined;

  // `window.a.b` / alias.a.b: the root must really be the global object.
  if (chain.parts.length > 0 && globalSymbols.roots.isGlobalRoot(chain.root)) {
    return chain.parts.join('.');
  }

  // `a.b` where `a.b` was registered as a global path: the root must not be a local binding.
  const rootSymbol = repository.checker.getSymbolAtLocation(chain.root);
  if (rootSymbol && !globalSymbols.resolveTypeScriptSymbol(rootSymbol)) return undefined;

  const path = [chain.root.text, ...chain.parts].join('.');
  return globalSymbols.candidates(path).length > 0 ? path : undefined;
}

/** `delete x` is a delete; `x = v` a write; `x += v` and `x++` read then write; the rest read. */
function classifyUse(node: ts.Expression): readonly UseKind[] {
  const parent = node.parent;

  if (ts.isDeleteExpression(parent) && parent.expression === node) return ['delete'];

  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return parent.operatorToken.kind === ts.SyntaxKind.EqualsToken ? ['write'] : ['read', 'write'];
  }

  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return ['read', 'write'];
  }

  return ['read'];
}

/** True for identifiers that are expressions (uses), not names being declared or property keys. */
function isIdentifierPosition(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  // Only the declared name or property key is excluded; an initializer is a real use.
  if (ts.isVariableDeclaration(parent) || ts.isParameter(parent)) return parent.name !== node;
  if (ts.isBindingElement(parent)) return parent.name !== node && parent.propertyName !== node;
  if (
    ts.isFunctionDeclaration(parent) ||
    ts.isClassDeclaration(parent) ||
    ts.isEnumDeclaration(parent)
  ) {
    return false;
  }
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) {
    return false;
  }
  if (
    ts.isExportSpecifier(parent) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakStatement(parent)
  ) {
    return false;
  }
  return true;
}
