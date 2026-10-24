import * as ts from 'typescript';
import type { Analyzer, AnalyzerOptions } from './types.js';
import type { RepositoryProgram } from './repository-program.js';
import {
  collectGlobalSymbols,
  type GlobalFact,
  type GlobalSymbolOptions,
} from './global-symbols.js';
import { collectEventRelationships } from './event-channels.js';
import { collectRegistryRelationships } from './registry-detection.js';
import type { RegistryProtocolOptions } from './registry-protocols.js';
import type { EventProtocolOptions } from './event-protocols.js';
import type { LoaderProtocol } from './loader-protocols.js';
import type { CallbackProtocol } from './callback-protocols.js';
import type { MetadataProtocol } from './metadata-protocols.js';
import { collectCallbackRelationships } from './callback-flow.js';
import { collectMetadataRelationships } from './metadata-reflect.js';
import { collectModuleLoads } from './module-loads.js';
import { applyModuleLoads } from './module-load-apply.js';
import { collectGlobalReferences } from './global-references.js';
import { collectStateRelationships } from './state-relationships.js';
import type { ResourceProtocol } from './resource-protocols.js';
import { collectResourceRelationships } from './resource-detection.js';
import type { ConfigProblem } from '../config/config-problem.js';
import type { StateConfig } from '../config/state-config.js';
import { resolveImportPath } from './resolver.js';
import type { ConnectionGraph } from '../graph.js';
import { normalizePath } from '../graph.js';
import type { SymbolType } from '../types.js';
import { applyDataEdges } from '../data/data-analyzer.js';
import { runDataEngine, type DataPathContext } from '../facts/data-engine.js';
import {
  defaultBareBases,
  servedBareBases,
  type BareBases,
  type PathBase,
} from '../facts/path-value.js';
import type { DataReferenceFact, FactLanguage } from '../facts/types.js';
import { duckDbFacts } from './duckdb-sql.js';
import { dataFlowFact, dataReferenceFact } from './data-facts.js';

export interface RepositoryAnalysisOptions {
  /** Every scanned repository path, used to place bare relative data paths (Phase 11.4). */
  readonly dataPaths?: ReadonlySet<string>;
  /** The base order from `data.pathBase` for JavaScript and TypeScript (Phase 11.4). */
  readonly pathBase?: readonly PathBase[];
  /** Global-symbol behavior from `.balk2.json`. */
  readonly globals?: GlobalSymbolOptions;
  /** Event protocol customization from `protocols.events` in `.balk2.json`. */
  readonly events?: EventProtocolOptions;
  /** Registry protocol customization from `protocols.registries` in `.balk2.json`. */
  readonly registries?: RegistryProtocolOptions;
  /** Loader functions from `protocols.loaders` in `.balk2.json`. */
  readonly loaders?: readonly LoaderProtocol[];
  /** Callback-receiving functions from `protocols.callbacks` in `.balk2.json`. */
  readonly callbacks?: readonly CallbackProtocol[];
  /** Reflect metadata keys from `protocols.metadata` in `.balk2.json`. */
  readonly metadata?: readonly MetadataProtocol[];
  /** Loader-style resource functions from `protocols.resources` in `.balk2.json`. */
  readonly resources?: readonly ResourceProtocol[];
  /** Shared-state behavior from the `state` section of `.balk2.json`. */
  readonly state?: StateConfig;
}

export interface RepositoryAnalysis {
  /**
   * Independent declare/read/write/delete observations about globals, including
   * ambiguous ones. They are not part of the v1 graph schema yet.
   */
  readonly globalFacts: readonly GlobalFact[];
  /** Configured state singletons that matched no export; not written into the graph. */
  readonly stateProblems: readonly ConfigProblem[];
}

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
  analyzeRepository(
    repository: RepositoryProgram,
    graph: ConnectionGraph,
    options: RepositoryAnalysisOptions = {},
  ): RepositoryAnalysis {
    const globalSymbols = collectGlobalSymbols(repository, options.globals);
    const knownFiles = Array.from(repository.sourceFiles.keys());

    for (const [filePath, sourceFile] of repository.sourceFiles) {
      this.analyzeSourceFile(filePath, sourceFile, graph, {
        rootDir: repository.rootDir,
        knownFiles,
        repository,
        dataPaths: options.dataPaths,
        pathBase: options.pathBase,
      });
    }

    // Dynamic module loads. Internal and loader loads add edges; `require` edges from the
    // per-file pass are not restamped, so an existing static import keeps its edge unchanged.
    const loads = collectModuleLoads(repository, options.loaders ?? []);
    applyModuleLoads(loads, graph);

    // Callbacks passed to configured functions. Symbols from the per-file pass already exist.
    collectCallbackRelationships(repository, graph, options.callbacks ?? []);

    // Reflect metadata with configured keys. Runs after the per-file pass, so targets exist.
    collectMetadataRelationships(repository, graph, options.metadata ?? []);

    // Templates, stylesheets and schemas. Runs after the per-file pass, so the importing file exists.
    collectResourceRelationships(repository, graph, options.resources ?? []);

    for (const globalSymbol of globalSymbols.effective()) {
      if (!graph.hasSymbol(globalSymbol.symbolId)) {
        graph.addSymbol(globalSymbol.filePath, globalSymbol.name, globalSymbol.symbolType);
      }
    }

    const globalFacts: GlobalFact[] = [...globalSymbols.declarationFacts()];
    for (const [filePath, sourceFile] of repository.sourceFiles) {
      globalFacts.push(
        ...collectGlobalReferences(sourceFile, filePath, repository, globalSymbols, graph),
      );
    }

    // State first: a call on shared state is state, so event and registry detection skip it.
    const state = collectStateRelationships(repository, graph, globalSymbols, options.state);
    collectEventRelationships(repository, graph, options.events, state.claimed);
    collectRegistryRelationships(repository, graph, options.registries, state.claimed);

    return { globalFacts, stateProblems: state.problems };
  }

  private analyzeSourceFile(
    normalizedPath: string,
    sourceFile: ts.SourceFile,
    graph: ConnectionGraph,
    options?: AnalyzerOptions,
  ): void {
    const language: FactLanguage = isTypeScript(normalizedPath) ? 'typescript' : 'javascript';

    graph.addFile(normalizedPath, language);

    // Context tracking for analysis pass
    const importsMap = new Map<string, { targetFile: string; importedName: string }>();
    const topLevelSymbols = new Map<string, { id: string; type: SymbolType }>();

    // Pass 1: Discover imports, symbols, exports, extends/implements
    const dataFacts: DataReferenceFact[] = [];
    const dataResolution = options?.repository
      ? {
          checker: options.repository.checker,
          language,
          repoPathOf: repositoryPathOf(options.repository),
        }
      : undefined;
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
        const fact = dataReferenceFact(node, sourceFile, normalizedPath, dataResolution);
        if (fact) dataFacts.push(fact);
        // SQL sent to a DuckDB handle names the files it reads and writes (Phase 11.6).
        if (dataResolution) {
          dataFacts.push(...duckDbFacts(node, sourceFile, normalizedPath, dataResolution));
        }
      } else if (ts.isIdentifier(node) && dataResolution) {
        // A `const` string passed to a catalog call (Phase 11.5).
        const fact = dataFlowFact(node, sourceFile, normalizedPath, dataResolution);
        if (fact) dataFacts.push(fact);
      }

      ts.forEachChild(node, visitFirstPass);
    };

    visitFirstPass(sourceFile);
    applyDataEdges(
      graph,
      runDataEngine({
        facts: dataFacts,
        paths: dataPathContext(language, options?.dataPaths, options?.pathBase),
      }),
    );

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
        handleCall(node, callerId, graph, importsMap, topLevelSymbols, options?.repository);
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

/**
 * Whether an identifier refers to a module-level binding: an import, or a declaration that is a
 * top-level statement. A local binding (a `const` inside a function, a parameter) shadows the
 * module's names, so a call through it is not a call to them (9.9 A).
 */
function refersToModuleBinding(identifier: ts.Identifier, checker: ts.TypeChecker): boolean {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (declaration === undefined) return true;
  if (
    ts.isImportSpecifier(declaration) ||
    ts.isImportClause(declaration) ||
    ts.isNamespaceImport(declaration) ||
    ts.isImportEqualsDeclaration(declaration)
  ) {
    return true;
  }
  // A variable's statement is the declaration that sits in the module; other declarations (functions,
  // classes, enums) are top-level when their own parent is the file.
  let node: ts.Node = declaration;
  while (
    ts.isVariableDeclaration(node) ||
    ts.isVariableDeclarationList(node) ||
    ts.isBindingElement(node) ||
    ts.isObjectBindingPattern(node) ||
    ts.isArrayBindingPattern(node)
  ) {
    node = node.parent;
  }
  if (ts.isVariableStatement(node)) return ts.isSourceFile(node.parent);
  return ts.isSourceFile(declaration.parent);
}

/** Repository path of each parsed file, by its source file. Built once per repository. */
const sourcePathCache = new WeakMap<RepositoryProgram, Map<ts.SourceFile, string>>();

function pathOfSourceFile(repository: RepositoryProgram, file: ts.SourceFile): string | undefined {
  let paths = sourcePathCache.get(repository);
  if (paths === undefined) {
    paths = new Map([...repository.sourceFiles].map(([path, source]) => [source, path]));
    sourcePathCache.set(repository, paths);
  }
  return paths.get(file);
}

/**
 * Whether a module gets a name from two `export *` declarations and does not declare it itself.
 * TypeScript then leaves the name unresolved, so no single symbol is the target (9.9 D).
 */
function ambiguousStarExport(
  specifier: ts.Expression,
  name: string,
  checker: ts.TypeChecker,
): boolean {
  const moduleSymbol = checker.getSymbolAtLocation(specifier);
  const file = moduleSymbol?.declarations?.find(ts.isSourceFile);
  if (moduleSymbol === undefined || file === undefined) return false;
  const own = checker.getExportsOfModule(moduleSymbol).find((symbol) => symbol.name === name);
  if (own?.declarations?.some((declaration) => declaration.getSourceFile() === file)) return false;
  let providers = 0;
  for (const statement of file.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.exportClause !== undefined ||
      statement.moduleSpecifier === undefined
    ) {
      continue;
    }
    const target = checker.getSymbolAtLocation(statement.moduleSpecifier);
    if (target === undefined) continue;
    if (checker.getExportsOfModule(target).some((symbol) => symbol.name === name)) providers += 1;
  }
  return providers > 1;
}

/**
 * The repository symbol an imported name resolves to, followed through re-exports (9.9 E).
 * Undefined when the identifier is not an import alias, so the caller keeps the import's own
 * target. Null when the alias does not resolve to one repository symbol (an ambiguous `export *`,
 * or a module outside the repository), so no edge is drawn.
 */
function aliasTarget(
  identifier: ts.Identifier,
  importedName: string,
  checker: ts.TypeChecker,
  repository: RepositoryProgram,
): string | null | undefined {
  const symbol = checker.getSymbolAtLocation(identifier);
  if (symbol === undefined || !(symbol.flags & ts.SymbolFlags.Alias)) return undefined;
  const importDecl = ts.findAncestor(symbol.declarations?.[0], ts.isImportDeclaration);
  if (
    importDecl !== undefined &&
    ambiguousStarExport(importDecl.moduleSpecifier, importedName, checker)
  ) {
    return null;
  }
  const aliased = checker.getAliasedSymbol(symbol);
  const declaration = aliased.declarations?.[0];
  if (declaration === undefined) return null;
  const file = pathOfSourceFile(repository, declaration.getSourceFile());
  return file === undefined ? null : `${file}:${aliased.getName()}`;
}

/**
 * The method a call on a typed receiver names, as a symbol id, or null (Phase 2.5). The receiver's
 * type comes from the checker, so `user.save()` after `const user = new User()` names `User.save`,
 * and `super.save()` names the base class method. Only a method of a repository class counts.
 */
function typedMethodTarget(
  access: ts.PropertyAccessExpression,
  checker: ts.TypeChecker,
  repository: RepositoryProgram,
): string | null {
  const receiverType = checker.getTypeAtLocation(access.expression);
  const classSymbol = receiverType.getSymbol();
  if (classSymbol === undefined || (classSymbol.flags & ts.SymbolFlags.Class) === 0) return null;
  const member = checker.getPropertyOfType(receiverType, access.name.text);
  const declaration = member?.valueDeclaration ?? member?.declarations?.[0];
  if (declaration === undefined || !ts.isMethodDeclaration(declaration)) return null;
  const owner = declaration.parent;
  if (!ts.isClassDeclaration(owner) || owner.name === undefined) return null;
  const file = pathOfSourceFile(repository, declaration.getSourceFile());
  if (file === undefined) return null;
  return `${file}:${owner.name.text}.${access.name.text}`;
}

function handleCall(
  node: ts.CallExpression | ts.NewExpression,
  callerId: string,
  graph: ConnectionGraph,
  importsMap: Map<string, { targetFile: string; importedName: string }>,
  topLevelSymbols: Map<string, { id: string; type: SymbolType }>,
  repository?: RepositoryProgram,
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

  const checker = repository?.checker;
  if (
    checker !== undefined &&
    repository !== undefined &&
    ts.isPropertyAccessExpression(node.expression)
  ) {
    const target = typedMethodTarget(node.expression, checker, repository);
    if (target !== null) {
      graph.addRelationship('calls', callerId, target);
      return;
    }
  }
  if (checker !== undefined && ts.isIdentifier(node.expression)) {
    if (!refersToModuleBinding(node.expression, checker)) return;
  }

  const imported = importsMap.get(calleeName);
  if (imported) {
    const aliased =
      checker !== undefined && repository !== undefined && ts.isIdentifier(node.expression)
        ? aliasTarget(node.expression, imported.importedName, checker, repository)
        : undefined;
    if (aliased === null) return;
    const targetSymbolId = aliased ?? `${imported.targetFile}:${imported.importedName}`;
    graph.addRelationship('calls', callerId, targetSymbolId);
    return;
  }

  const localSym = topLevelSymbols.get(calleeName);
  if (localSym) {
    graph.addRelationship('calls', callerId, localSym.id);
  }
}

/**
 * The path context for one file's data facts (Phase 11.4). Without a set of scanned paths the
 * facts keep their paths as written, as a single-file analysis does.
 */
function dataPathContext(
  language: FactLanguage,
  dataPaths: ReadonlySet<string> | undefined,
  pathBase: readonly PathBase[] | undefined,
): DataPathContext | undefined {
  if (dataPaths === undefined) return undefined;
  return {
    exists: (repoPath) => dataPaths.has(repoPath),
    // A flowed constant is placed from the file that declares it (Phase 11.5). A served URL path is
    // placed from the package's public folder (Phase 11.6).
    bases: (fact): BareBases => {
      const placedFrom = fact.pathFilePath ?? fact.filePath;
      if (fact.api?.served) {
        return servedBareBases({ package: nearestPackageDir(placedFrom, dataPaths) ?? '' });
      }
      return defaultBareBases(language, { file: dirOf(placedFrom) }, pathBase);
    },
  };
}

/** The nearest directory holding a package.json, walking up from a file, or undefined (Phase 11.6). */
function nearestPackageDir(filePath: string, dataPaths: ReadonlySet<string>): string | undefined {
  let dir = dirOf(filePath);
  for (;;) {
    if (dataPaths.has(dir === '' ? 'package.json' : `${dir}/package.json`)) return dir;
    if (dir === '') return undefined;
    dir = dirOf(dir);
  }
}

/** The directory of a repository path, or '' for a file at the root. */
function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash < 0 ? '' : filePath.slice(0, slash);
}

const repositoryPathsByRepository = new WeakMap<RepositoryProgram, Map<ts.SourceFile, string>>();

/** Maps a source file of the repository to its repository path, built once per repository. */
function repositoryPathOf(
  repository: RepositoryProgram,
): (sf: ts.SourceFile) => string | undefined {
  let byFile = repositoryPathsByRepository.get(repository);
  if (!byFile) {
    byFile = new Map([...repository.sourceFiles].map(([filePath, sf]) => [sf, filePath]));
    repositoryPathsByRepository.set(repository, byFile);
  }
  const paths = byFile;
  return (sf) => paths.get(sf);
}
