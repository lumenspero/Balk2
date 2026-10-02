import * as ts from 'typescript';
import type { SymbolType } from '../types.js';
import type { RepositoryProgram } from './repository-program.js';

const GLOBAL_ROOTS = new Set(['globalThis', 'window', 'self', 'global']);

export interface GlobalSymbol {
  readonly name: string;
  readonly filePath: string;
  readonly symbolId: string;
  readonly symbolType: SymbolType;
  readonly origin: 'script' | 'assignment' | 'ambient';
  readonly declaration: ts.Node;
  readonly typeScriptSymbol?: ts.Symbol;
}

export class GlobalSymbolIndex {
  private readonly symbolsByName = new Map<string, GlobalSymbol[]>();

  add(symbol: GlobalSymbol): void {
    const existing = this.symbolsByName.get(symbol.name) ?? [];
    existing.push(symbol);
    this.symbolsByName.set(symbol.name, existing);
  }

  all(): readonly GlobalSymbol[] {
    return Array.from(this.symbolsByName.values()).flat();
  }

  resolve(name: string): GlobalSymbol | undefined {
    const candidates = this.symbolsByName.get(name);
    return candidates?.length === 1 ? candidates[0] : undefined;
  }

  resolveTypeScriptSymbol(symbol: ts.Symbol): GlobalSymbol | undefined {
    const candidates = this.symbolsByName.get(symbol.getName());
    if (!candidates) return undefined;

    const matches = candidates.filter((candidate) => candidate.typeScriptSymbol === symbol);
    return matches.length === 1 ? matches[0] : undefined;
  }
}

/** Collect globally visible script declarations and explicit assignments. */
export function collectGlobalSymbols(repository: RepositoryProgram): GlobalSymbolIndex {
  const index = new GlobalSymbolIndex();

  for (const [filePath, sourceFile] of repository.sourceFiles) {
    if (!ts.isExternalModule(sourceFile)) {
      for (const statement of sourceFile.statements) {
        collectDeclaration(statement, filePath, 'script', repository, index);
      }
    }

    const visit = (node: ts.Node): void => {
      if (ts.isModuleDeclaration(node) && node.name.kind === ts.SyntaxKind.GlobalKeyword) {
        collectAmbientDeclarations(node.body, filePath, repository, index);
      }

      if (ts.isBinaryExpression(node) && isAssignmentOperator(node.operatorToken.kind)) {
        const name = getGlobalAssignmentName(node.left);
        if (name) {
          const existing = index.resolve(name);
          if (!existing || existing.filePath !== filePath) {
            index.add({
              name,
              filePath,
              symbolId: `${filePath}:${name}`,
              symbolType: inferAssignedSymbolType(node.right),
              origin: 'assignment',
              declaration: node.left,
            });
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return index;
}

export function getStaticPropertyPath(node: ts.Expression): string | undefined {
  const parts: string[] = [];
  let current: ts.Expression = node;

  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (ts.isPropertyAccessExpression(current)) {
      parts.unshift(current.name.text);
      current = current.expression;
      continue;
    }

    const argument = current.argumentExpression;
    if (!argument || !ts.isStringLiteral(argument)) return undefined;
    parts.unshift(argument.text);
    current = current.expression;
  }

  if (!ts.isIdentifier(current)) return undefined;
  return [current.text, ...parts].join('.');
}

function collectAmbientDeclarations(
  body: ts.ModuleBody | undefined,
  filePath: string,
  repository: RepositoryProgram,
  index: GlobalSymbolIndex,
): void {
  if (!body || !ts.isModuleBlock(body)) return;
  for (const statement of body.statements) {
    collectDeclaration(statement, filePath, 'ambient', repository, index);
  }
}

function collectDeclaration(
  statement: ts.Statement,
  filePath: string,
  origin: 'script' | 'ambient',
  repository: RepositoryProgram,
  index: GlobalSymbolIndex,
): void {
  if (ts.isFunctionDeclaration(statement) && statement.name) {
    addDeclaration(statement.name, 'function', statement, filePath, origin, repository, index);
  } else if (ts.isClassDeclaration(statement) && statement.name) {
    addDeclaration(statement.name, 'class', statement, filePath, origin, repository, index);
  } else if (ts.isEnumDeclaration(statement)) {
    addDeclaration(statement.name, 'variable', statement, filePath, origin, repository, index);
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        const symbolType = declaration.initializer && isFunctionLike(declaration.initializer)
          ? 'function'
          : statement.declarationList.flags & ts.NodeFlags.Const
            ? 'constant'
            : 'variable';
        addDeclaration(declaration.name, symbolType, declaration, filePath, origin, repository, index);
      }
    }
  }
}

function addDeclaration(
  nameNode: ts.Identifier,
  symbolType: SymbolType,
  declaration: ts.Node,
  filePath: string,
  origin: 'script' | 'ambient',
  repository: RepositoryProgram,
  index: GlobalSymbolIndex,
): void {
  index.add({
    name: nameNode.text,
    filePath,
    symbolId: `${filePath}:${nameNode.text}`,
    symbolType,
    origin,
    declaration,
    typeScriptSymbol: repository.checker.getSymbolAtLocation(nameNode),
  });
}

function getGlobalAssignmentName(node: ts.Expression): string | undefined {
  const path = getStaticPropertyPath(node);
  if (!path) return undefined;
  const [root, ...parts] = path.split('.');
  return root && GLOBAL_ROOTS.has(root) && parts.length > 0 ? parts.join('.') : undefined;
}

function inferAssignedSymbolType(node: ts.Expression): SymbolType {
  if (ts.isClassExpression(node)) return 'class';
  return isFunctionLike(node) ? 'function' : 'variable';
}

function isFunctionLike(node: ts.Expression): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function isAssignmentOperator(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}
