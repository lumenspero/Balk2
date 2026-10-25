import type { SourceSpan } from '../../types.js';
import { exprChildren, stmtBlocks, stmtOwnExprs } from '../python/ast-walk.js';
import type { CallArg, Expr, Span, Stmt } from '../python/ast.js';
import { dottedName } from '../python/expression-format.js';
import { parseModuleRecovering } from '../python/statement-parser.js';
import { splitWords } from './commands.js';
import type { ProcessCall } from './types.js';

/** The subprocess calls. The first positional argument, or `args=`, names the command. */
const SUBPROCESS = new Set([
  'subprocess.run',
  'subprocess.call',
  'subprocess.check_call',
  'subprocess.check_output',
  'subprocess.Popen',
]);
/** `os.system` runs a command line through a shell. */
const SYSTEM = 'os.system';
const KNOWN = new Set([...SUBPROCESS, SYSTEM]);

interface Context {
  readonly file: string;
  /** Local name to the dotted name it imports. */
  readonly aliases: Map<string, string>;
  readonly calls: ProcessCall[];
}

/**
 * The process-execution calls in Python (V3 Phase 14.5): `subprocess` and `os.system`, reached
 * through an import. Each call's owner is its enclosing `def`.
 */
export function pythonProcesses(
  files: readonly { readonly filePath: string; readonly source: string }[],
): ProcessCall[] {
  const calls: ProcessCall[] = [];
  for (const file of files) {
    const body = parseModuleRecovering(file.source).body;
    const ctx: Context = { file: file.filePath, aliases: new Map(), calls };
    collectAliases(body, ctx.aliases);
    walk(body, file.filePath, ctx);
  }
  return calls;
}

function collectAliases(body: readonly Stmt[], aliases: Map<string, string>): void {
  for (const statement of body) {
    if (statement.kind === 'import') {
      for (const alias of statement.names) {
        if (alias.asname !== null) {
          aliases.set(alias.asname, alias.name);
        } else {
          const head = alias.name.split('.')[0] ?? alias.name;
          aliases.set(head, head);
        }
      }
    } else if (
      statement.kind === 'importfrom' &&
      statement.level === 0 &&
      statement.module !== null &&
      statement.names !== 'star'
    ) {
      for (const alias of statement.names) {
        aliases.set(alias.asname ?? alias.name, `${statement.module}.${alias.name}`);
      }
    }
    for (const block of childBodies(statement)) collectAliases(block, aliases);
  }
}

function childBodies(statement: Stmt): (readonly Stmt[])[] {
  return statement.kind === 'funcdef' || statement.kind === 'classdef'
    ? [statement.body, ...stmtBlocks(statement)]
    : stmtBlocks(statement);
}

function walk(body: readonly Stmt[], owner: string, ctx: Context): void {
  for (const statement of body) {
    if (statement.kind === 'funcdef') {
      walk(statement.body, `${ctx.file}:${statement.name}`, ctx);
      continue;
    }
    if (statement.kind === 'classdef') {
      walk(statement.body, owner, ctx);
      continue;
    }
    for (const expression of stmtOwnExprs(statement)) visit(expression, owner, ctx);
    for (const block of stmtBlocks(statement)) walk(block, owner, ctx);
  }
}

function visit(expression: Expr, owner: string, ctx: Context): void {
  if (expression.kind === 'call') {
    const callee = calleeOf(expression.func, ctx.aliases);
    if (callee !== undefined) {
      ctx.calls.push({
        file: ctx.file,
        owner,
        callee,
        argv: argvOf(callee, expression.args),
        span: spanOf(expression.span, ctx.file),
      });
    }
  }
  for (const child of exprChildren(expression)) visit(child, owner, ctx);
}

/** The dotted name of a callee with its head resolved through the imports, when it is known. */
function calleeOf(func: Expr, aliases: ReadonlyMap<string, string>): string | undefined {
  const dotted = dottedName(func);
  if (dotted === undefined) return undefined;
  const [head = '', ...rest] = dotted.split('.');
  const resolved = [aliases.get(head) ?? head, ...rest].join('.');
  return KNOWN.has(resolved) ? resolved : undefined;
}

/** The argv a call runs, or null when the command is not a literal. */
function argvOf(callee: string, args: readonly CallArg[]): readonly string[] | null {
  const positional = args.find((arg) => arg.kind === 'positional');
  const keyword = args.find((arg) => arg.kind === 'keyword' && arg.name === 'args');
  const command = positional ?? (callee === SYSTEM ? undefined : keyword);
  if (command === undefined) return null;
  return commandValue(command.value);
}

/** A command line split into words, or a list of literal words. */
function commandValue(expression: Expr): readonly string[] | null {
  if (expression.kind === 'constant') {
    const text = pyString(expression);
    return text === undefined ? null : splitWords(text);
  }
  if (expression.kind === 'list' || expression.kind === 'tuple') {
    const words: string[] = [];
    for (const element of expression.elements) {
      const word = pyString(element);
      if (word === undefined) return null;
      words.push(word);
    }
    return words;
  }
  return null;
}

/** The text of a plain (non-f) string literal, without escapes. Undefined for anything else. */
function pyString(expression: Expr): string | undefined {
  if (expression.kind !== 'constant' || expression.type !== 'str') return undefined;
  const match = /^[rRuU]*(?:('''|""")([\s\S]*)\1|('|")([\s\S]*)\3)$/.exec(expression.raw);
  if (match === null) return undefined;
  return match[2] ?? match[4] ?? '';
}

function spanOf(span: Span, file: string): SourceSpan {
  return {
    filePath: file,
    startLine: span.line,
    startColumn: span.column,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}
