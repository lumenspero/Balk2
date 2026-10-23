import * as ts from 'typescript';
import { lookupDataApi } from '../facts/data-catalog.js';
import type { DataApiMatch, FactLanguage } from '../facts/types.js';
import { isPathBuilderCall } from './data-literals.js';

/**
 * Resolves the library API a data literal is passed to (V3 Phase 11.1). A call matches a catalog
 * entry only when the callee's name is bound by an import from that module, as the checker sees
 * it. A local variable, parameter or property with the same name never matches.
 */

/** What an identifier is bound to by an import declaration. */
interface ImportBinding {
  /** The module the import names, with any `node:` prefix removed. */
  readonly module: string;
  /** The export imported, `*` for a namespace import, or `default` for a default import. */
  readonly imported: string;
}

/** Removes the `node:` scheme so `node:fs` and `fs` name one module. */
function bareModule(specifier: string): string {
  return specifier.startsWith('node:') ? specifier.slice('node:'.length) : specifier;
}

/** The module a `require('m')` call names, or undefined for any other expression (Phase 11.6). */
function requiredModule(expression: ts.Expression | undefined): string | undefined {
  if (!expression || !ts.isCallExpression(expression)) return undefined;
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'require') {
    return undefined;
  }
  const [argument] = expression.arguments;
  if (expression.arguments.length !== 1 || !argument || !ts.isStringLiteral(argument)) {
    return undefined;
  }
  return bareModule(argument.text);
}

/**
 * A binding a CommonJS `require` introduces: `const fs = require('fs')` binds the module, and
 * `const { readFile } = require('fs')` binds one export (Phase 11.6).
 */
function requireBindingOf(declaration: ts.Declaration): ImportBinding | undefined {
  if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
    const module = requiredModule(declaration.initializer);
    return module === undefined ? undefined : { module, imported: '*' };
  }
  if (
    ts.isBindingElement(declaration) &&
    ts.isObjectBindingPattern(declaration.parent) &&
    ts.isIdentifier(declaration.name) &&
    ts.isVariableDeclaration(declaration.parent.parent)
  ) {
    const module = requiredModule(declaration.parent.parent.initializer);
    if (module === undefined) return undefined;
    const imported = declaration.propertyName ?? declaration.name;
    return ts.isIdentifier(imported) ? { module, imported: imported.text } : undefined;
  }
  return undefined;
}

/** The binding a declaration introduces when it is an import or a `require`, or undefined. */
function importBindingOf(declaration: ts.Declaration): ImportBinding | undefined {
  const required = requireBindingOf(declaration);
  if (required) return required;
  if (ts.isNamespaceImport(declaration)) {
    return moduleBinding(declaration.parent.parent, '*');
  }
  if (ts.isImportClause(declaration)) {
    return moduleBinding(declaration.parent, 'default');
  }
  if (ts.isImportSpecifier(declaration)) {
    const importDeclaration = declaration.parent.parent.parent;
    return moduleBinding(importDeclaration, (declaration.propertyName ?? declaration.name).text);
  }
  return undefined;
}

function moduleBinding(declaration: ts.Node, imported: string): ImportBinding | undefined {
  if (!ts.isImportDeclaration(declaration)) return undefined;
  if (!ts.isStringLiteral(declaration.moduleSpecifier)) return undefined;
  return { module: bareModule(declaration.moduleSpecifier.text), imported };
}

/** The import an identifier refers to, as the checker resolves it, or undefined. */
function bindingOf(identifier: ts.Identifier, checker: ts.TypeChecker): ImportBinding | undefined {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  return declaration ? importBindingOf(declaration) : undefined;
}

/** A module and export a call expression names, through its import bindings. */
export interface ResolvedApi {
  readonly module: string;
  readonly name: string;
}

/**
 * A global the language library declares, such as `fetch`, named as the module `global` (Phase 11.6).
 * A function the program declares itself is not a library global, so it does not match.
 */
function globalApi(identifier: ts.Identifier, checker: ts.TypeChecker): ResolvedApi | undefined {
  const declaration = checker.getSymbolAtLocation(identifier)?.declarations?.[0];
  if (declaration === undefined || !declaration.getSourceFile().hasNoDefaultLib) return undefined;
  return { module: 'global', name: identifier.text };
}

/**
 * The module export a callee names, for these forms:
 * - `fn(...)` with `import { fn } from 'm'`
 * - `ns.fn(...)` with `import * as ns from 'm'` or `import ns from 'm'`
 * - `ns.promises.fn(...)` with `fs`, which names `fs/promises`
 * - `promises.fn(...)` with `import { promises } from 'fs'`
 */
export function resolveCallee(
  callee: ts.Expression,
  checker: ts.TypeChecker,
): ResolvedApi | undefined {
  if (ts.isIdentifier(callee)) {
    const binding = bindingOf(callee, checker);
    if (!binding) return globalApi(callee, checker);
    if (binding.imported === '*' || binding.imported === 'default') return undefined;
    return { module: binding.module, name: binding.imported };
  }

  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const object = callee.expression;
  const name = callee.name.text;

  if (ts.isIdentifier(object)) {
    const binding = bindingOf(object, checker);
    if (!binding) return undefined;
    if (binding.imported === '*' || binding.imported === 'default') {
      return { module: binding.module, name };
    }
    if (binding.module === 'fs' && binding.imported === 'promises') {
      return { module: 'fs/promises', name };
    }
    return undefined;
  }

  if (
    ts.isPropertyAccessExpression(object) &&
    object.name.text === 'promises' &&
    ts.isIdentifier(object.expression)
  ) {
    const binding = bindingOf(object.expression, checker);
    if (
      binding &&
      binding.module === 'fs' &&
      (binding.imported === '*' || binding.imported === 'default')
    ) {
      return { module: 'fs/promises', name };
    }
  }

  return undefined;
}

/**
 * The data catalog match for a string literal, when the literal is an argument of a resolved
 * catalog call. Path builders such as `path.join` are looked through, as the context is.
 */
export function dataApiOfLiteral(
  literal: ts.Node,
  checker: ts.TypeChecker,
  language: FactLanguage,
): DataApiMatch | undefined {
  let argument: ts.Node = literal;
  while (argument.parent && isPathBuilderCall(argument.parent)) {
    argument = argument.parent;
  }

  const call = argument.parent;
  if (!call || !ts.isCallExpression(call)) return undefined;
  const index = call.arguments.findIndex((arg) => arg === argument);
  if (index < 0) return undefined;

  const resolved = resolveCallee(call.expression, checker);
  if (!resolved) return undefined;

  const entry = lookupDataApi(language, resolved.module, resolved.name, index);
  return entry
    ? {
        module: entry.module,
        name: entry.name,
        direction: entry.direction,
        ...(entry.served ? { served: true } : {}),
      }
    : undefined;
}

/** A catalog call that receives a `const` string binding (Phase 11.5). */
export interface FlowedDataUse {
  readonly api: DataApiMatch;
  /** The string the constant holds. */
  readonly path: string;
  /** The call the constant is passed to. */
  readonly call: ts.CallExpression;
  /** The declaring file, as a repository path, when the checker can place it. */
  readonly declaringFile: string;
}

/**
 * Whether no code in the scope that holds a variable assigns to it after its declaration (Phase
 * 11.5). The scope is the nearest function or source file, which is conservative for `let` and `var`:
 * a reassignment anywhere in the function counts, so a binding that might change never flows.
 */
function isNeverReassigned(
  declaration: ts.VariableDeclaration,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  let scope: ts.Node = declaration;
  while (!ts.isSourceFile(scope) && !ts.isFunctionLike(scope)) scope = scope.parent;

  const isVariable = (node: ts.Node | undefined): boolean =>
    node !== undefined && ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol;
  // An assignment target may be the variable itself or a destructuring pattern that holds it.
  const targetsVariable = (target: ts.Node): boolean => {
    if (isVariable(target)) return true;
    if (!ts.isArrayLiteralExpression(target) && !ts.isObjectLiteralExpression(target)) return false;
    let found = false;
    ts.forEachChild(target, (child) => {
      if (targetsVariable(child)) found = true;
    });
    return found;
  };

  let reassigned = false;
  const visit = (node: ts.Node): void => {
    if (reassigned) return;
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      targetsVariable(node.left)
    ) {
      reassigned = true;
      return;
    }
    if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken ||
        node.operator === ts.SyntaxKind.MinusMinusToken) &&
      isVariable(node.operand)
    ) {
      reassigned = true;
      return;
    }
    if (
      (ts.isForInStatement(node) || ts.isForOfStatement(node)) &&
      !ts.isVariableDeclarationList(node.initializer) &&
      targetsVariable(node.initializer)
    ) {
      reassigned = true;
      return;
    }
    // A second `var` declaration with an initializer assigns the variable again.
    if (
      node !== declaration &&
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isIdentifier(node.name) &&
      checker.getSymbolAtLocation(node.name) === symbol
    ) {
      reassigned = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return !reassigned;
}

/**
 * The catalog call an identifier is passed to, when the identifier names a variable whose
 * initializer is a string literal (Phase 11.5). A `const` always holds that literal; a `let` or
 * `var` holds it only when nothing in its function assigns it again. The constant may be local or
 * imported; the checker follows the import to its declaration. `repoPathOf` gives the repository
 * path of a source file.
 */
export function flowedDataUse(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  language: FactLanguage,
  repoPathOf: (sourceFile: ts.SourceFile) => string | undefined,
): FlowedDataUse | undefined {
  const call = identifier.parent;
  if (!call || !ts.isCallExpression(call)) return undefined;
  const index = call.arguments.findIndex((arg) => arg === identifier);
  if (index < 0) return undefined;

  const resolved = resolveCallee(call.expression, checker);
  const entry = resolved
    ? lookupDataApi(language, resolved.module, resolved.name, index)
    : undefined;
  if (!entry) return undefined;

  let symbol = checker.getSymbolAtLocation(identifier);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration || !ts.isVariableDeclaration(declaration)) return undefined;
  if (!symbol || !ts.isVariableDeclarationList(declaration.parent)) return undefined;
  const isConst = (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
  if (!isConst && !isNeverReassigned(declaration, symbol, checker)) return undefined;
  const initializer = declaration.initializer;
  if (!initializer || !ts.isStringLiteral(initializer)) return undefined;

  const declaringFile = repoPathOf(declaration.getSourceFile());
  if (declaringFile === undefined) return undefined;
  return {
    api: { module: entry.module, name: entry.name, direction: entry.direction },
    path: initializer.text,
    call,
    declaringFile,
  };
}
