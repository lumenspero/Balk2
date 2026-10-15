import * as ts from 'typescript';
import type { LoadKind, SourceSpan } from '../types.js';
import { enclosingOwner } from './owner.js';
import type { RepositoryProgram } from './repository-program.js';
import { snippetOf, spanOf } from './spans.js';

/** Bounds `const a = b` chains so a malformed alias cannot recurse forever. */
const MAX_DEPTH = 8;

interface ModuleLoadBase {
  /** Repository-relative file containing the load */
  readonly filePath: string;
  /** Symbol or file that performs the load, as `enclosingOwner` names it */
  readonly owner: string;
  readonly span: SourceSpan;
  readonly subject: string;
  readonly loadKind: LoadKind;
}

/**
 * One dynamic module load, with what its specifier resolved to.
 *
 * - `internal`: a repository file (`target`).
 * - `external`: a package or built-in; not an error, and not a repository edge.
 * - `unresolved`: a relative or absolute specifier that names no repository file.
 * - `dynamic`: the specifier is not a constant, so its target is unknown.
 */
export type ModuleLoad =
  | (ModuleLoadBase & { readonly status: 'internal'; readonly specifier: string; readonly target: string })
  | (ModuleLoadBase & { readonly status: 'external'; readonly specifier: string })
  | (ModuleLoadBase & { readonly status: 'unresolved'; readonly specifier: string })
  | (ModuleLoadBase & { readonly status: 'dynamic'; readonly reason: string });

/**
 * Find dynamic module loads in every analyzed JS/TS file, in a stable order:
 *
 * - `import('./x')` and `import(expr)` (`import-expression`)
 * - `new Worker(new URL('./x', import.meta.url))` (`worker`)
 * - `new URL('./x', import.meta.url)` outside a worker (`url`)
 *
 * Plain `require('./x')` is not reported here. `handleRequireCall` already maps every literal
 * `require`, wherever it appears, so the wiring step stamps `loadKind` on that existing edge.
 *
 * A `new URL` whose second argument is not `import.meta.url` is not a module load and is skipped.
 */
export function collectModuleLoads(repository: RepositoryProgram): ModuleLoad[] {
  const loads: ModuleLoad[] = [];
  const files = [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  for (const [filePath, sourceFile] of files) {
    if (sourceFile.isDeclarationFile) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const load = describeImportCall(node, filePath, repository);
        if (load) loads.push(load);
      } else if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'URL'
      ) {
        const load = describeUrl(node, filePath, repository);
        if (load) loads.push(load);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return loads;
}

function describeImportCall(
  node: ts.CallExpression,
  filePath: string,
  repository: RepositoryProgram,
): ModuleLoad | undefined {
  const specifier = node.arguments[0];
  if (!specifier) return undefined;

  return resolveLoad(
    baseOf(node, filePath, 'import-expression'),
    specifier,
    repository,
  );
}

function describeUrl(
  node: ts.NewExpression,
  filePath: string,
  repository: RepositoryProgram,
): ModuleLoad | undefined {
  const args = node.arguments ?? [];
  const [specifier, base] = args;
  if (!specifier || !base || !isImportMetaUrl(base)) return undefined;

  const parent = node.parent;
  const isWorker =
    ts.isNewExpression(parent) &&
    ts.isIdentifier(parent.expression) &&
    parent.expression.text === 'Worker' &&
    parent.arguments?.[0] === node;

  return resolveLoad(
    baseOf(node, filePath, isWorker ? 'worker' : 'url'),
    specifier,
    repository,
  );
}

function baseOf(node: ts.Node, filePath: string, loadKind: LoadKind): ModuleLoadBase {
  return {
    filePath,
    owner: enclosingOwner(node, filePath),
    span: spanOf(node, filePath),
    subject: snippetOf(node),
    loadKind,
  };
}

function resolveLoad(
  base: ModuleLoadBase,
  specifierExpression: ts.Expression,
  repository: RepositoryProgram,
): ModuleLoad {
  const specifier = constantString(specifierExpression, repository.checker, 0);
  if (specifier === undefined) {
    return { ...base, status: 'dynamic', reason: 'the module specifier is not a constant' };
  }

  const resolved = repository.resolveModule(base.filePath, specifier);
  if (resolved.kind === 'internal' && resolved.path !== undefined) {
    return { ...base, status: 'internal', specifier, target: resolved.path };
  }
  if (resolved.kind === 'external') {
    return { ...base, status: 'external', specifier };
  }
  return { ...base, status: 'unresolved', specifier };
}

/** `import.meta.url`, the base for a URL-relative module load. */
function isImportMetaUrl(expression: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    expression.name.text === 'url' &&
    ts.isMetaProperty(expression.expression) &&
    expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword
  );
}

/**
 * The string an expression always evaluates to, or `undefined` when it depends on runtime values.
 * Covers string literals, no-substitution templates, parentheses and `as` casts, and identifiers
 * bound by `const` to such an expression.
 */
function constantString(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  depth: number,
): string | undefined {
  if (depth > MAX_DEPTH) return undefined;

  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    return constantString(expression.expression, checker, depth + 1);
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isIdentifier(expression)) {
    const declaration = checker.getSymbolAtLocation(expression)?.valueDeclaration;
    if (
      declaration &&
      ts.isVariableDeclaration(declaration) &&
      ts.isIdentifier(declaration.name) &&
      declaration.initializer &&
      ts.isVariableDeclarationList(declaration.parent) &&
      (declaration.parent.flags & ts.NodeFlags.Const) !== 0
    ) {
      return constantString(declaration.initializer, checker, depth + 1);
    }
  }
  return undefined;
}