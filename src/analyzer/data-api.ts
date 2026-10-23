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

/** The binding a declaration introduces when it is an import, or undefined otherwise. */
function importBindingOf(declaration: ts.Declaration): ImportBinding | undefined {
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
    if (!binding || binding.imported === '*' || binding.imported === 'default') return undefined;
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
  if (!call.arguments.some((arg) => arg === argument)) return undefined;

  const resolved = resolveCallee(call.expression, checker);
  if (!resolved) return undefined;

  const entry = lookupDataApi(language, resolved.module, resolved.name);
  return entry ? { module: entry.module, name: entry.name, direction: entry.direction } : undefined;
}
