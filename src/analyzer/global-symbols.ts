import * as ts from 'typescript';
import { normalizePath } from '../graph.js';
import type { Confidence, SymbolType } from '../types.js';
import type { RepositoryProgram } from './repository-program.js';

/** Default global-object roots. Configuration will extend this set (see Phase 8). */
export const GLOBAL_ROOTS: ReadonlySet<string> = new Set([
  'globalThis',
  'window',
  'self',
  'global',
]);

const MAX_ALIAS_DEPTH = 4;

/** 1-based position in a repository file. */
export interface SourceLocation {
  readonly filePath: string;
  readonly line: number;
  readonly column: number;
}

/** Where a global is established: straight-line file code, or inside a function/class body. */
export type GlobalScope = 'top-level' | 'function';

export interface GlobalSymbol {
  readonly name: string;
  readonly filePath: string;
  readonly symbolId: string;
  readonly symbolType: SymbolType;
  readonly origin: 'script' | 'assignment' | 'ambient';
  readonly declaration: ts.Node;
  readonly typeScriptSymbol?: ts.Symbol;
  /** `top-level` declarations outrank in-function assignments when a name is resolved. */
  readonly scope: GlobalScope;
  /** True when the declaration (or, for an assignment, the assigned binding) is exported. */
  readonly exported: boolean;
  /** Where the declaration or establishing assignment is written. */
  readonly location: SourceLocation;
}

/** Optional behavior supplied from `.balk2.json` (`globals`). */
export interface GlobalSymbolOptions {
  /** Replaces the default global roots when provided. */
  readonly roots?: readonly string[];
  /** Selects the owning file for a duplicated global name, e.g. `{ "init": "src/legacy.js" }`. */
  readonly targets?: Readonly<Record<string, string>>;
}

export type GlobalFactKind = 'declare' | 'read' | 'write' | 'delete';

/**
 * One observation about a global, kept independent of graph edges so later phases
 * (state analysis, diagnostics) can reuse it. Ambiguous observations carry the
 * candidate origins and low confidence instead of a target.
 */
export interface GlobalFact {
  readonly kind: GlobalFactKind;
  readonly name: string;
  readonly location: SourceLocation;
  /** Symbol id of the enclosing symbol, or the file path for file-level code. */
  readonly owner: string;
  readonly resolution: 'resolved' | 'selected' | 'ambiguous';
  readonly confidence: Confidence;
  readonly targetSymbolId?: string;
  /** Candidate symbol ids, sorted, present when `resolution` is `ambiguous`. */
  readonly candidates?: readonly string[];
}

export type GlobalLookup =
  | { readonly kind: 'resolved' | 'selected'; readonly symbol: GlobalSymbol }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly GlobalSymbol[] }
  | { readonly kind: 'none' };

/**
 * Decides whether an identifier denotes the global object. A name such as
 * `self` or `window` only counts when it is not bound to a repository-local
 * declaration (parameter, local variable, import, ...). Statically established
 * aliases (`const root = globalThis`) are followed.
 */
export class GlobalRootResolver {
  private readonly repositoryFiles: ReadonlySet<ts.SourceFile>;

  constructor(
    private readonly repository: RepositoryProgram,
    private readonly roots: ReadonlySet<string> = GLOBAL_ROOTS,
  ) {
    this.repositoryFiles = new Set(repository.sourceFiles.values());
  }

  isGlobalRoot(node: ts.Identifier, depth = 0): boolean {
    if (depth > MAX_ALIAS_DEPTH) return false;

    const symbol = this.repository.checker.getSymbolAtLocation(node);
    const bound = (symbol?.declarations ?? []).filter((d) => this.isRepositoryBinding(d));

    // Unbound, or bound only by lib/ambient declarations: the name itself decides.
    if (bound.length === 0) return this.roots.has(node.text);

    const [only] = bound;
    if (
      bound.length === 1 &&
      only &&
      ts.isVariableDeclaration(only) &&
      ts.isIdentifier(only.name) &&
      (only.parent.flags & ts.NodeFlags.Const) !== 0 &&
      only.initializer
    ) {
      const initializer = skipParentheses(only.initializer);
      if (ts.isIdentifier(initializer)) return this.isGlobalRoot(initializer, depth + 1);
    }

    return false;
  }

  private isRepositoryBinding(declaration: ts.Declaration): boolean {
    // Only declarations that genuinely bind a name count. The JS binder also records
    // `window.x = ...` / `globalThis.x = ...` as a "declaration" of the root in the
    // assigning file; that is an assignment, not a local binding.
    if (!BINDING_DECLARATION_GUARDS.some((isBinding) => isBinding(declaration))) return false;
    const sourceFile = declaration.getSourceFile();
    return this.repositoryFiles.has(sourceFile) && !sourceFile.isDeclarationFile;
  }
}

const BINDING_DECLARATION_GUARDS: ReadonlyArray<(node: ts.Node) => boolean> = [
  ts.isVariableDeclaration,
  ts.isParameter,
  ts.isBindingElement,
  ts.isFunctionDeclaration,
  ts.isFunctionExpression,
  ts.isClassDeclaration,
  ts.isClassExpression,
  ts.isEnumDeclaration,
  ts.isModuleDeclaration,
  ts.isImportClause,
  ts.isImportSpecifier,
  ts.isNamespaceImport,
  ts.isImportEqualsDeclaration,
];

export class GlobalSymbolIndex {
  private readonly symbolsByName = new Map<string, GlobalSymbol[]>();
  private readonly targets: ReadonlyMap<string, string>;

  constructor(
    readonly roots: GlobalRootResolver,
    targets: Readonly<Record<string, string>> = {},
  ) {
    this.targets = new Map(
      Object.entries(targets).map(([name, file]) => [name, normalizePath(file)]),
    );
  }

  /**
   * Add a candidate. A second entry with the same symbol id (overloads, repeated
   * assignments) is the same symbol, except that a top-level establishment replaces
   * an in-function one.
   */
  add(symbol: GlobalSymbol): void {
    const existing = this.symbolsByName.get(symbol.name) ?? [];
    const duplicate = existing.findIndex((candidate) => candidate.symbolId === symbol.symbolId);
    if (duplicate >= 0) {
      if (existing[duplicate]?.scope === 'function' && symbol.scope === 'top-level') {
        existing[duplicate] = symbol;
      }
      return;
    }
    existing.push(symbol);
    this.symbolsByName.set(symbol.name, existing);
  }

  all(): readonly GlobalSymbol[] {
    return Array.from(this.symbolsByName.values()).flat();
  }

  /**
   * Effective candidates for a name. Top-level declarations and assignments win;
   * in-function assignments only count when the name has no top-level origin.
   */
  candidates(name: string): readonly GlobalSymbol[] {
    const all = this.symbolsByName.get(name) ?? [];
    const topLevel = all.filter((candidate) => candidate.scope === 'top-level');
    return topLevel.length > 0 ? topLevel : all;
  }

  /** Every effective candidate across all names (what deserves a graph node). */
  effective(): readonly GlobalSymbol[] {
    return Array.from(this.symbolsByName.keys()).flatMap((name) => this.candidates(name));
  }

  lookup(name: string): GlobalLookup {
    return this.decide(name, this.candidates(name));
  }

  lookupTypeScriptSymbol(symbol: ts.Symbol): GlobalLookup {
    const name = symbol.getName();
    return this.decide(
      name,
      this.candidates(name).filter((candidate) => candidate.typeScriptSymbol === symbol),
    );
  }

  resolve(name: string): GlobalSymbol | undefined {
    return unwrap(this.lookup(name));
  }

  resolveTypeScriptSymbol(symbol: ts.Symbol): GlobalSymbol | undefined {
    return unwrap(this.lookupTypeScriptSymbol(symbol));
  }

  /** The effective candidate that `node` establishes, if it is a declaring site. */
  declaredAt(node: ts.Node): GlobalSymbol | undefined {
    return this.all().find(
      (symbol) => symbol.declaration === node && this.candidates(symbol.name).includes(symbol),
    );
  }

  /** `declare` facts for script and ambient declarations (assignments are reported at their use sites). */
  declarationFacts(): readonly GlobalFact[] {
    return this.all()
      .filter((symbol) => symbol.origin !== 'assignment')
      .map((symbol) => ({
        kind: 'declare' as const,
        name: symbol.name,
        location: symbol.location,
        owner: symbol.symbolId,
        resolution: 'resolved' as const,
        confidence: 'high' as const,
        targetSymbolId: symbol.symbolId,
      }));
  }

  private decide(name: string, pool: readonly GlobalSymbol[]): GlobalLookup {
    const [only] = pool;
    if (!only) return { kind: 'none' };
    if (pool.length === 1) return { kind: 'resolved', symbol: only };

    const targetFile = this.targets.get(name);
    const selected = targetFile
      ? pool.filter((candidate) => candidate.filePath === targetFile)
      : [];
    const [chosen] = selected;
    if (chosen && selected.length === 1) return { kind: 'selected', symbol: chosen };

    return { kind: 'ambiguous', candidates: pool };
  }
}

function unwrap(lookup: GlobalLookup): GlobalSymbol | undefined {
  return lookup.kind === 'resolved' || lookup.kind === 'selected' ? lookup.symbol : undefined;
}

/** Collect globally visible script declarations and explicit assignments. */
export function collectGlobalSymbols(
  repository: RepositoryProgram,
  options: GlobalSymbolOptions = {},
): GlobalSymbolIndex {
  const roots = new GlobalRootResolver(
    repository,
    options.roots ? new Set(options.roots) : GLOBAL_ROOTS,
  );
  const index = new GlobalSymbolIndex(roots, options.targets);

  for (const [filePath, sourceFile] of repository.sourceFiles) {
    if (isScriptFile(sourceFile)) {
      for (const statement of sourceFile.statements) {
        collectDeclaration(statement, filePath, 'script', repository, index);
      }
    }

    const visit = (node: ts.Node): void => {
      if (ts.isModuleDeclaration(node) && (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0) {
        collectAmbientDeclarations(node.body, filePath, repository, index);
      }

      if (ts.isBinaryExpression(node) && isDeclaringAssignment(node.operatorToken.kind)) {
        const name = getGlobalAssignmentName(node.left, index.roots);
        if (name) {
          index.add({
            name,
            filePath,
            symbolId: `${filePath}:${name}`,
            symbolType: inferAssignedSymbolType(node.right),
            origin: 'assignment',
            declaration: node.left,
            scope: scopeOf(node),
            exported: isExportedValue(node.right, repository.checker),
            location: locationOf(node.left, filePath),
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);
  }

  return index;
}

/**
 * True when a top-level declaration in this file lands in the global scope.
 *
 * The compiler's own module detection is not usable here: under
 * `module: node16`/`nodenext` (and `moduleDetection: force`) it reports every
 * file as a module. Detection is therefore syntactic: a file is a script when
 * it has no import/export syntax and shows no CommonJS module markers.
 */
export function isScriptFile(sourceFile: ts.SourceFile): boolean {
  if (sourceFile.isDeclarationFile) return !ts.isExternalModule(sourceFile);
  if (/\.(mjs|mts|cjs|cts)$/i.test(sourceFile.fileName)) return false;
  return !hasModuleSyntax(sourceFile) && !usesCommonJs(sourceFile);
}

export interface StaticPropertyChain {
  readonly root: ts.Identifier;
  readonly parts: readonly string[];
}

/** Decompose `a.b['c'].d` into its root identifier and static property names. */
export function getStaticPropertyChain(node: ts.Expression): StaticPropertyChain | undefined {
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

  return ts.isIdentifier(current) ? { root: current, parts } : undefined;
}

export function getStaticPropertyPath(node: ts.Expression): string | undefined {
  const chain = getStaticPropertyChain(node);
  return chain ? [chain.root.text, ...chain.parts].join('.') : undefined;
}

/** `window.a.b` / `root.a.b` (with `root` an alias of the global object) -> `a.b`. */
export function getGlobalAssignmentName(
  node: ts.Expression,
  roots: GlobalRootResolver,
): string | undefined {
  const chain = getStaticPropertyChain(node);
  if (!chain || chain.parts.length === 0) return undefined;
  return roots.isGlobalRoot(chain.root) ? chain.parts.join('.') : undefined;
}

function hasModuleSyntax(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement) ||
      ts.isExportAssignment(statement) ||
      ts.isNamespaceExportDeclaration(statement)
    ) {
      return true;
    }
    if (
      ts.isImportEqualsDeclaration(statement) &&
      ts.isExternalModuleReference(statement.moduleReference)
    ) {
      return true;
    }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    return modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  });
}

function usesCommonJs(sourceFile: ts.SourceFile): boolean {
  let found = false;

  const visit = (node: ts.Node): void => {
    if (found) return;

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      found = true;
      return;
    }

    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const root = node.expression.text;
      if ((root === 'module' && node.name.text === 'exports') || root === 'exports') {
        found = true;
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
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
  } else if (
    ts.isModuleDeclaration(statement) &&
    ts.isIdentifier(statement.name) &&
    (statement.flags & ts.NodeFlags.GlobalAugmentation) === 0
  ) {
    addDeclaration(statement.name, 'variable', statement, filePath, origin, repository, index);
  } else if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        const symbolType: SymbolType =
          declaration.initializer && isFunctionLike(declaration.initializer)
            ? 'function'
            : statement.declarationList.flags & ts.NodeFlags.Const
              ? 'constant'
              : 'variable';
        addDeclaration(
          declaration.name,
          symbolType,
          declaration,
          filePath,
          origin,
          repository,
          index,
        );
      }
    }
  }
}

function addDeclaration(
  nameNode: ts.Identifier,
  symbolType: SymbolType,
  declaration: ts.Declaration,
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
    scope: 'top-level',
    exported: isExportedDeclaration(declaration),
    location: locationOf(nameNode, filePath),
  });
}

export function locationOf(node: ts.Node, filePath: string): SourceLocation {
  const sourceFile = node.getSourceFile();
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { filePath, line: line + 1, column: character + 1 };
}

/** `function` when the node sits inside any function-like or class body. */
function scopeOf(node: ts.Node): GlobalScope {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current) || ts.isClassLike(current)) return 'function';
  }
  return 'top-level';
}

function isExportedDeclaration(declaration: ts.Declaration): boolean {
  return (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !== 0;
}

/** `window.App = App` where `App` is an exported binding. */
function isExportedValue(value: ts.Expression, checker: ts.TypeChecker): boolean {
  if (!ts.isIdentifier(value)) return false;
  const declaration = checker.getSymbolAtLocation(value)?.declarations?.[0];
  return !!declaration && isExportedDeclaration(declaration);
}

function inferAssignedSymbolType(node: ts.Expression): SymbolType {
  if (ts.isClassExpression(node)) return 'class';
  return isFunctionLike(node) ? 'function' : 'variable';
}

function isFunctionLike(node: ts.Expression): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** `=`, `||=` and `??=` establish a global; `+=`, `*=` and friends only modify one. */
function isDeclaringAssignment(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken
  );
}

function skipParentheses(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}
