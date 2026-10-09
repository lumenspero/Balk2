import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type { Evidence, SourceSpan } from '../types.js';
import {
  getStaticPropertyChain,
  locationOf,
  type GlobalFact,
  type GlobalLookup,
  type GlobalSymbol,
  type GlobalSymbolIndex,
} from './global-symbols.js';
import { ownerOf } from './owner.js';
import type { RepositoryProgram } from './repository-program.js';
import { snippetOf, spanOf } from './spans.js';

type UseKind = 'read' | 'write' | 'delete';

/**
 * Resolution pass: walk one file and relate its uses of globals to the global index.
 *
 * Reads and deletes of a unique target become `references` edges (symbol-level and
 * file-level). Every use, including writes and ambiguous ones, is also returned as an
 * independent {@link GlobalFact}. A read or delete of a name with several candidate origins
 * never produces an edge to any of them: it becomes an `ambiguous-global` unresolved
 * observation, linked from the using symbol by a low-confidence `references` edge. A write
 * stays a fact only, as writes never produce edges.
 */
export function collectGlobalReferences(
  sourceFile: ts.SourceFile,
  fromFile: string,
  repository: RepositoryProgram,
  globalSymbols: GlobalSymbolIndex,
  graph: ConnectionGraph,
): GlobalFact[] {
  const facts: GlobalFact[] = [];

  const addReference = (
    owner: string,
    target: GlobalSymbol,
    span: SourceSpan,
    evidence: Evidence,
  ): void => {
    if (target.filePath === fromFile) return;

    // Repeated uses merge in the graph, which keeps every call site.
    graph.addRelationship('references', owner, target.symbolId, 'high', {
      evidence,
      spans: [span],
    });
    graph.addRelationship('references', fromFile, target.filePath);
  };

  const observeAmbiguity = (
    name: string,
    node: ts.Expression,
    owner: string,
    candidates: readonly GlobalSymbol[],
    span: SourceSpan,
    evidence: Evidence,
  ): void => {
    const observation = graph.addUnresolved({
      reason: 'ambiguous-global',
      attempted: 'references',
      subject: snippetOf(node),
      location: span,
      candidates: candidates.map((candidate) => candidate.symbolId),
      detail: `"${name}" is declared in ${describeFiles(candidates)}; choose one with globals.targets`,
    });
    graph.addRelationship('references', owner, observation.id, 'low', {
      evidence,
      spans: [span],
    });
  };

  const record = (
    name: string,
    node: ts.Expression,
    owner: string,
    lookup: GlobalLookup,
    viaSymbol: boolean,
  ): void => {
    if (lookup.kind === 'none') return;

    const location = locationOf(node, fromFile);
    const span = spanOf(node, fromFile);
    const found: Evidence = viaSymbol ? 'ts-program' : 'ast';

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
        if (use !== 'write') {
          observeAmbiguity(name, node, owner, lookup.candidates, span, found);
        }
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
      if (use !== 'write') {
        addReference(owner, lookup.symbol, span, lookup.kind === 'selected' ? 'config' : found);
      }
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
        if (name) record(name, node, owner ?? fromFile, globalSymbols.lookup(name), false);
      }
    } else if (ts.isIdentifier(node) && isIdentifierPosition(node)) {
      const symbol = repository.checker.getSymbolAtLocation(node);
      const lookup = symbol
        ? globalSymbols.lookupTypeScriptSymbol(symbol)
        : globalSymbols.lookup(node.text);
      record(node.text, node, owner ?? fromFile, lookup, symbol !== undefined);
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

/** `a.js`, `a.js and b.js`, or `a.js, b.js, c.js and 2 more`. */
function describeFiles(candidates: readonly GlobalSymbol[]): string {
  const files = [...new Set(candidates.map((candidate) => candidate.filePath))].sort();
  if (files.length <= 2) return files.join(' and ');
  if (files.length === 3) return `${files[0]}, ${files[1]} and ${files[2]}`;
  return `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`;
}
