import * as ts from 'typescript';
import type { Analyzer, AnalyzerOptions } from './types.js';
import type { RepositoryProgram } from './repository-program.js';
import {
  collectGlobalSymbols,
  getStaticPropertyPath,
  type GlobalSymbol,
  type GlobalSymbolIndex,
} from './global-symbols.js';
import { resolveImportPath } from './resolver.js';
import type { ConnectionGraph } from '../graph.js';
import { normalizePath } from '../graph.js';
import type { SymbolType } from '../types.js';
import { isDataArtifact } from '../data/formats.js';
import { inferDataRelationshipType, addDataRelationship } from '../data/data-analyzer.js';

export class JsTsAnalyzer implements Analyzer {
  readonly name = 'JsTsAnalyzer';
  readonly supportedExtensions: readonly string[] = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs'];

  canAnalyze(filePath: string): boolean {
    const normalized = normalizePath(filePath).toLowerCase();
    return this.supportedExtensions.some((ext) => normalized.endsWith(ext));
  }

  analyzeFile(
    filePath: string,
    content: string,
    graph: ConnectionGraph,
    options?: AnalyzerOptions,
  ): void {
    const normalizedPath = normalizePath(filePath);
    const scriptKind = getScriptKind(normalizedPath);
    const sourceFile = ts.createSourceFile(
      normalizedPath,
      content,
      ts.ScriptTarget.Latest,
      true,
      scriptKind,
    );

    this.analyzeSourceFile(normalizedPath, sourceFile, graph, options);
  }

  /** Analyze every parsed JS/TS file in one shared repository session. */
  analyzeRepository(repository: RepositoryProgram, graph: ConnectionGraph): void {
    const globalSymbols = collectGlobalSymbols(repository);

    for (const [filePath, sourceFile] of repository.sourceFiles) {
      this.analyzeSourceFile(filePath, sourceFile, graph, {
        rootDir: repository.rootDir,
        knownFiles: Array.from(repository.sourceFiles.keys()),
        repository,
      });
    }

    for (const globalSymbol of globalSymbols.all()) {
      if (!graph.hasSymbol(globalSymbol.symbolId)) {
        graph.addSymbol(globalSymbol.filePath, globalSymbol.name, globalSymbol.symbolType);
      }
    }

    for (const [filePath, sourceFile] of repository.sourceFiles) {
      addGlobalReferenceRelationships(sourceFile, filePath, repository, globalSymbols, graph);
    }
  }

  private analyzeSourceFile(
    normalizedPath: string,
    sourceFile: ts.SourceFile,
    graph: ConnectionGraph,
    options?: AnalyzerOptions,
  ): void {
    const language = isTypeScript(normalizedPath) ? 'typescript' : 'javascript';

    graph.addFile(normalizedPath, language);

    // Context tracking for analysis pass
    const importsMap = new Map<string, { targetFile: string; importedName: string }>();
    const topLevelSymbols = new Map<string, { id: string; type: SymbolType }>();

    // Pass 1: Discover imports, symbols, exports, extends/implements
    const visitFirstPass = (node: ts.Node): void => {
      // ── Imports & Re-exports ────────────────────────────────────────
      if (ts.isImportDeclaration(node)) {
        handleImportDeclaration(node, normalizedPath, graph, options, importsMap);
      } else if (ts.isExportDeclaration(node)) {
        handleExportDeclaration(node, normalizedPath, graph, options);
      } else if (ts.isCallExpression(node) && isRequireCall(node)) {
        handleRequireCall(node, normalizedPath, graph, options, importsMap);
      }

      // ── Functions ──────────────────────────────────────────────────
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        const sym = graph.addSymbol(normalizedPath, name, 'function');
        topLevelSymbols.set(name, { id: sym.id, type: 'function' });

        if (isExported(node)) {
          graph.addRelationship('exports', normalizedPath, sym.id);
        }
      }

      // ── Classes & Methods ───────────────────────────────────────────
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        const classSym = graph.addSymbol(normalizedPath, className, 'class');
        topLevelSymbols.set(className, { id: classSym.id, type: 'class' });

        if (isExported(node)) {
          graph.addRelationship('exports', normalizedPath, classSym.id);
        }

        // Class inheritance & interface implementations
        if (node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            const relType =
              clause.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
            for (const typeNode of clause.types) {
              const baseName = typeNode.expression.getText(sourceFile);
              const imported = importsMap.get(baseName);
              const target = imported
                ? `${imported.targetFile}:${imported.importedName}`
                : baseName;
              graph.addRelationship(relType, classSym.id, target);
            }
          }
        }

        // Class methods
        for (const member of node.members) {
          if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
            const methodName = member.name.text;
            const fullMethodName = `${className}.${methodName}`;
            const methodSym = graph.addSymbol(normalizedPath, fullMethodName, 'method');
            topLevelSymbols.set(fullMethodName, { id: methodSym.id, type: 'method' });
          }
        }
      }

      // ── Type Aliases & Interfaces ──────────────────────────────────
      if (ts.isTypeAliasDeclaration(node)) {
        const name = node.name.text;
        const sym = graph.addSymbol(normalizedPath, name, 'type');
        topLevelSymbols.set(name, { id: sym.id, type: 'type' });
        if (isExported(node)) {
          graph.addRelationship('exports', normalizedPath, sym.id);
        }
      }

      if (ts.isInterfaceDeclaration(node)) {
        const name = node.name.text;
        const sym = graph.addSymbol(normalizedPath, name, 'type');
        topLevelSymbols.set(name, { id: sym.id, type: 'type' });
        if (isExported(node)) {
          graph.addRelationship('exports', normalizedPath, sym.id);
        }
      }

      // ── Top-level Variables / Functions assigned to const/let ─────
      if (ts.isVariableStatement(node)) {
        const isExp = isExported(node);
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const varName = decl.name.text;
            const isFn =
              decl.initializer &&
              (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer));
            const symbolType: SymbolType = isFn
              ? 'function'
              : node.declarationList.flags & ts.NodeFlags.Const
                ? 'constant'
                : 'variable';

            const sym = graph.addSymbol(normalizedPath, varName, symbolType);
            topLevelSymbols.set(varName, { id: sym.id, type: symbolType });

            if (isExp) {
              graph.addRelationship('exports', normalizedPath, sym.id);
            }
          }
        }
      }

      // ── Data Artifact References ────────────────────────────────────
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        const text = node.text;
        if (isDataArtifact(text)) {
          const context = node.parent ? node.parent.getText(sourceFile) : '';
          const relType = inferDataRelationshipType(context);
          addDataRelationship(normalizedPath, text, relType, graph, 'high');
        }
      }

      ts.forEachChild(node, visitFirstPass);
    };

    visitFirstPass(sourceFile);

    // Pass 2: Discover call relationships with enclosing symbol awareness
    const visitSecondPass = (node: ts.Node, currentSymbolId?: string): void => {
      let enclosingSymbolId = currentSymbolId;

      if (ts.isFunctionDeclaration(node) && node.name) {
        enclosingSymbolId = `${normalizedPath}:${node.name.text}`;
      } else if (ts.isClassDeclaration(node) && node.name) {
        enclosingSymbolId = `${normalizedPath}:${node.name.text}`;
      } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        const className = getParentClassName(node);
        if (className) {
          enclosingSymbolId = `${normalizedPath}:${className}.${node.name.text}`;
        }
      }

      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const callerId = enclosingSymbolId ?? normalizedPath;
        handleCall(node, callerId, graph, importsMap, topLevelSymbols);
      }

      ts.forEachChild(node, (child) => visitSecondPass(child, enclosingSymbolId));
    };

    visitSecondPass(sourceFile);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function isTypeScript(path: string): boolean {
  const p = path.toLowerCase();
  return p.endsWith('.ts') || p.endsWith('.tsx');
}

function getScriptKind(path: string): ts.ScriptKind {
  const p = path.toLowerCase();
  if (p.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (p.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (p.endsWith('.ts')) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function isExported(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function handleImportDeclaration(
  node: ts.ImportDeclaration,
  fromFile: string,
  graph: ConnectionGraph,
  options: AnalyzerOptions | undefined,
  importsMap: Map<string, { targetFile: string; importedName: string }>,
): void {
  if (!ts.isStringLiteral(node.moduleSpecifier)) return;
  const specifier = node.moduleSpecifier.text;
  const targetFile = resolveInternalModule(fromFile, specifier, options);
  if (!targetFile) return;

  graph.addRelationship('imports', fromFile, targetFile);
  graph.addRelationship('importedBy', targetFile, fromFile);

  if (node.importClause) {
    if (node.importClause.name) {
      importsMap.set(node.importClause.name.text, { targetFile, importedName: 'default' });
    }
    if (node.importClause.namedBindings) {
      if (ts.isNamedImports(node.importClause.namedBindings)) {
        for (const element of node.importClause.namedBindings.elements) {
          const importedName = element.propertyName ? element.propertyName.text : element.name.text;
          const localName = element.name.text;
          importsMap.set(localName, { targetFile, importedName });
        }
      } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
        importsMap.set(node.importClause.namedBindings.name.text, {
          targetFile,
          importedName: '*',
        });
      }
    }
  }
}

function handleExportDeclaration(
  node: ts.ExportDeclaration,
  fromFile: string,
  graph: ConnectionGraph,
  options: AnalyzerOptions | undefined,
): void {
  if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    const specifier = node.moduleSpecifier.text;
    const targetFile = resolveInternalModule(fromFile, specifier, options);
    if (targetFile) {
      graph.addRelationship('imports', fromFile, targetFile);
      graph.addRelationship('importedBy', targetFile, fromFile);
    }
  }
}

function isRequireCall(node: ts.CallExpression): boolean {
  return (
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'require' &&
    node.arguments.length > 0
  );
}

function handleRequireCall(
  node: ts.CallExpression,
  fromFile: string,
  graph: ConnectionGraph,
  options: AnalyzerOptions | undefined,
  importsMap: Map<string, { targetFile: string; importedName: string }>,
): void {
  const firstArg = node.arguments[0];
  if (firstArg && ts.isStringLiteral(firstArg)) {
    const specifier = firstArg.text;
    const targetFile = resolveInternalModule(fromFile, specifier, options);
    if (targetFile) {
      graph.addRelationship('imports', fromFile, targetFile);
      graph.addRelationship('importedBy', targetFile, fromFile);

      if (
        node.parent &&
        ts.isVariableDeclaration(node.parent) &&
        ts.isObjectBindingPattern(node.parent.name)
      ) {
        for (const elt of node.parent.name.elements) {
          if (ts.isIdentifier(elt.name)) {
            const propName =
              elt.propertyName && ts.isIdentifier(elt.propertyName)
                ? elt.propertyName.text
                : elt.name.text;
            importsMap.set(elt.name.text, { targetFile, importedName: propName });
          }
        }
      }
    }
  }
}

function resolveInternalModule(
  fromFile: string,
  specifier: string,
  options?: AnalyzerOptions,
): string | undefined {
  const resolved = options?.repository?.resolveModule(fromFile, specifier);
  if (resolved) return resolved.kind === 'internal' ? resolved.path : undefined;
  return resolveImportPath(fromFile, specifier, options?.knownFiles);
}

function getParentClassName(node: ts.MethodDeclaration): string | undefined {
  if (node.parent && ts.isClassDeclaration(node.parent) && node.parent.name) {
    return node.parent.name.text;
  }
  return undefined;
}

function handleCall(
  node: ts.CallExpression | ts.NewExpression,
  callerId: string,
  graph: ConnectionGraph,
  importsMap: Map<string, { targetFile: string; importedName: string }>,
  topLevelSymbols: Map<string, { id: string; type: SymbolType }>,
): void {
  let calleeName = '';

  if (ts.isIdentifier(node.expression)) {
    calleeName = node.expression.text;
  } else if (ts.isPropertyAccessExpression(node.expression)) {
    calleeName = node.expression.name.text;
  } else return;

  if (
    ['console', 'require', 'import', 'Math', 'Object', 'Array', 'Promise', 'JSON'].includes(
      calleeName,
    )
  ) {
    return;
  }

  const imported = importsMap.get(calleeName);
  if (imported) {
    const targetSymbolId = `${imported.targetFile}:${imported.importedName}`;
    graph.addRelationship('calls', callerId, targetSymbolId);
    graph.addRelationship('calledBy', targetSymbolId, callerId);
    return;
  }

  const localSym = topLevelSymbols.get(calleeName);
  if (localSym) {
    graph.addRelationship('calls', callerId, localSym.id);
    graph.addRelationship('calledBy', localSym.id, callerId);
  }
}

function addGlobalReferenceRelationships(
  sourceFile: ts.SourceFile,
  fromFile: string,
  repository: RepositoryProgram,
  globalSymbols: GlobalSymbolIndex,
  graph: ConnectionGraph,
): void {
  const emitted = new Set<string>();

  const addReference = (owner: string, globalSymbol: GlobalSymbol): void => {
    if (globalSymbol.filePath === fromFile) return;

    const symbolKey = `references:${owner}:${globalSymbol.symbolId}`;
    if (!emitted.has(symbolKey)) {
      graph.addRelationship('references', owner, globalSymbol.symbolId);
      emitted.add(symbolKey);
    }

    const fileKey = `references:${fromFile}:${globalSymbol.filePath}`;
    if (!emitted.has(fileKey)) {
      graph.addRelationship('references', fromFile, globalSymbol.filePath);
      emitted.add(fileKey);
    }
  };

  const visit = (node: ts.Node, currentOwner?: string): void => {
    let owner = currentOwner;
    if (ts.isFunctionDeclaration(node) && node.name) {
      owner = `${fromFile}:${node.name.text}`;
    } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
      const className = getParentClassName(node);
      if (className) owner = `${fromFile}:${className}.${node.name.text}`;
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = getGlobalReferenceName(node, globalSymbols);
      const globalSymbol = name ? globalSymbols.resolve(name) : undefined;
      if (globalSymbol && !isAssignmentTarget(node)) addReference(owner ?? fromFile, globalSymbol);
    } else if (ts.isIdentifier(node) && isIdentifierReference(node)) {
      const globalSymbol = resolveIdentifierGlobal(node, repository, globalSymbols);
      if (globalSymbol) addReference(owner ?? fromFile, globalSymbol);
    }

    ts.forEachChild(node, (child) => visit(child, owner));
  };

  visit(sourceFile);
}

function resolveIdentifierGlobal(
  node: ts.Identifier,
  repository: RepositoryProgram,
  globalSymbols: GlobalSymbolIndex,
): GlobalSymbol | undefined {
  const symbol = repository.checker.getSymbolAtLocation(node);
  if (symbol) return globalSymbols.resolveTypeScriptSymbol(symbol);
  return globalSymbols.resolve(node.text);
}

function getGlobalReferenceName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  globalSymbols: GlobalSymbolIndex,
): string | undefined {
  const path = getStaticPropertyPath(node);
  if (!path) return undefined;

  const [root, ...parts] = path.split('.');
  if (['globalThis', 'window', 'self', 'global'].includes(root ?? '') && parts.length > 0) {
    return parts.join('.');
  }

  return globalSymbols.resolve(path) ? path : undefined;
}

function isIdentifierReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent || isAssignmentTarget(node)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) || ts.isVariableDeclaration(parent) || ts.isParameter(parent)) return false;
  if (ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isEnumDeclaration(parent)) {
    return false;
  }
  if (ts.isImportClause(parent) || ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent)) {
    return false;
  }
  if (ts.isExportSpecifier(parent) || ts.isLabeledStatement(parent) || ts.isBreakStatement(parent)) {
    return false;
  }
  return true;
}

function isAssignmentTarget(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    !!parent &&
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}
