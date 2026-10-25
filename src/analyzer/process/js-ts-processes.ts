import * as ts from 'typescript';
import { normalizePath } from '../../graph.js';
import type { SourceSpan } from '../../types.js';
import type { RepositoryProgram } from '../repository-program.js';
import { splitWords } from './commands.js';
import type { ProcessCall } from './types.js';

/** The modules that start processes. `node:` is the prefixed form of the same module. */
const MODULES = new Set(['child_process', 'node:child_process']);
/** Calls whose first argument is a whole command line, run through a shell. */
const COMMAND_LINE = new Set(['exec', 'execSync']);
/** Calls whose first argument is a program and whose second is an argument list or options. */
const PROGRAM = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync']);
/** `fork(modulePath, args)` runs Node on a module. */
const FORK = 'fork';
const KNOWN = new Set([...COMMAND_LINE, ...PROGRAM, FORK]);

interface Context {
  readonly file: string;
  readonly sourceFile: ts.SourceFile;
  /** Local identifier to the child_process member it names. */
  readonly names: Map<string, string>;
  /** Local identifiers that are the whole module (`import cp`, `import * as cp`, `require`). */
  readonly namespaces: Set<string>;
  readonly calls: ProcessCall[];
}

/**
 * The process-execution calls in JS/TS (V3 Phase 14.5): `child_process` functions reached through
 * a top-level import or require. Each call's owner is its enclosing named function.
 */
export function jsTsProcesses(repository: RepositoryProgram): ProcessCall[] {
  const calls: ProcessCall[] = [];
  for (const [rawFile, sourceFile] of repository.sourceFiles) {
    const file = normalizePath(rawFile);
    const ctx: Context = { file, sourceFile, names: new Map(), namespaces: new Set(), calls };
    collectModuleBindings(sourceFile, ctx);
    visit(sourceFile, file, ctx);
  }
  return calls;
}

function collectModuleBindings(sourceFile: ts.SourceFile, ctx: Context): void {
  for (const statement of sourceFile.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      MODULES.has(statement.moduleSpecifier.text)
    ) {
      const clause = statement.importClause;
      if (clause === undefined) continue;
      if (clause.name !== undefined) ctx.namespaces.add(clause.name.text);
      const bindings = clause.namedBindings;
      if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
        ctx.namespaces.add(bindings.name.text);
      } else if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          ctx.names.set(element.name.text, (element.propertyName ?? element.name).text);
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (declaration.initializer === undefined || !isRequireOfModule(declaration.initializer)) {
          continue;
        }
        if (ts.isIdentifier(declaration.name)) {
          ctx.namespaces.add(declaration.name.text);
        } else if (ts.isObjectBindingPattern(declaration.name)) {
          for (const element of declaration.name.elements) {
            if (!ts.isIdentifier(element.name)) continue;
            const source =
              element.propertyName !== undefined && ts.isIdentifier(element.propertyName)
                ? element.propertyName.text
                : element.name.text;
            ctx.names.set(element.name.text, source);
          }
        }
      }
    }
  }
}

function isRequireOfModule(expression: ts.Expression): boolean {
  if (
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    expression.expression.text !== 'require'
  ) {
    return false;
  }
  const [argument] = expression.arguments;
  return argument !== undefined && ts.isStringLiteral(argument) && MODULES.has(argument.text);
}

function visit(node: ts.Node, owner: string, ctx: Context): void {
  if (ts.isCallExpression(node)) {
    const member = memberOf(node.expression, ctx);
    if (member !== undefined) {
      ctx.calls.push({
        file: ctx.file,
        owner,
        callee: `child_process.${member}`,
        argv: argvOf(member, node.arguments),
        span: spanOf(node, ctx.sourceFile, ctx.file),
      });
    }
  }
  const inner = functionName(node, ctx.file) ?? owner;
  ts.forEachChild(node, (child) => {
    visit(child, inner, ctx);
  });
}

/** The child_process member a callee names, when it is reached through a known import. */
function memberOf(callee: ts.Expression, ctx: Context): string | undefined {
  if (ts.isIdentifier(callee)) {
    const member = ctx.names.get(callee.text);
    return member !== undefined && KNOWN.has(member) ? member : undefined;
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    ctx.namespaces.has(callee.expression.text) &&
    KNOWN.has(callee.name.text)
  ) {
    return callee.name.text;
  }
  return undefined;
}

/** The argv a call runs, or null when any part of it is not a string literal. */
function argvOf(member: string, args: readonly ts.Expression[]): readonly string[] | null {
  const [first, second] = args;
  if (first === undefined) return null;
  if (COMMAND_LINE.has(member)) {
    const line = literal(first);
    return line === undefined ? null : splitWords(line);
  }
  const program = literal(first);
  if (program === undefined) return null;
  const extra = argumentList(second);
  if (extra === null) return null;
  return member === FORK ? ['node', program, ...extra] : [program, ...extra];
}

/** An argument list of literals. A missing or options argument adds nothing. */
function argumentList(expression: ts.Expression | undefined): string[] | null {
  if (expression === undefined) return [];
  if (ts.isObjectLiteralExpression(expression)) return [];
  if (!ts.isArrayLiteralExpression(expression)) return null;
  const values: string[] = [];
  for (const element of expression.elements) {
    const value = literal(element);
    if (value === undefined) return null;
    values.push(value);
  }
  return values;
}

function literal(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return undefined;
}

/** The symbol id of a named function, method or arrow-valued variable, or undefined. */
function functionName(node: ts.Node, file: string): string | undefined {
  if (
    (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
    node.name !== undefined &&
    ts.isIdentifier(node.name)
  ) {
    return `${file}:${node.name.text}`;
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return `${file}:${node.name.text}`;
  }
  return undefined;
}

function spanOf(node: ts.Node, sourceFile: ts.SourceFile, file: string): SourceSpan {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    filePath: file,
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}
