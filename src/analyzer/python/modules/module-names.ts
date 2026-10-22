import type { Expr, Stmt } from '../ast.js';
import { parseModuleRecovering } from '../statement-parser.js';

/** The names a module binds at top level, and its static `__all__`, when it has one. */
export interface ModuleNames {
  /** Names bound at module level, in first-binding order, without duplicates */
  readonly bound: readonly string[];
  /**
   * The `__all__` list, when every assignment to it is a list or tuple of plain string literals.
   * Undefined when there is no `__all__`, or when it is built in a way that is not static.
   */
  readonly all?: readonly string[];
}

/**
 * The top-level names of a module, read from its statements. Function and class bodies bind in
 * their own scope and are not visited. Blocks such as `if`, `try` and `for` do bind at module level
 * and are visited. Star imports bind names that cannot be known here, so they add nothing.
 */
export function moduleNames(source: string): ModuleNames {
  const bound = new Set<string>();
  let all: string[] | undefined;
  let dynamicAll = false;

  const add = (name: string): void => {
    bound.add(name);
  };

  const addTarget = (target: Expr): void => {
    if (target.kind === 'name') add(target.id);
    else if (target.kind === 'tuple' || target.kind === 'list') {
      for (const element of target.elements) addTarget(element);
    } else if (target.kind === 'starred') addTarget(target.value);
  };

  const visit = (stmts: readonly Stmt[]): void => {
    for (const stmt of stmts) {
      switch (stmt.kind) {
        case 'funcdef':
        case 'classdef':
        case 'typealias':
          add(stmt.name);
          break;
        case 'assign': {
          for (const target of stmt.targets) addTarget(target);
          const assignsAll = stmt.targets.some((t) => isName(t, '__all__'));
          if (assignsAll) {
            const values = stmt.targets.length === 1 ? literalStrings(stmt.value) : undefined;
            if (values === undefined) dynamicAll = true;
            else all = values;
          }
          break;
        }
        case 'annassign': {
          addTarget(stmt.target);
          if (isName(stmt.target, '__all__')) {
            const values = stmt.value ? literalStrings(stmt.value) : undefined;
            if (values === undefined) dynamicAll = true;
            else all = values;
          }
          break;
        }
        case 'augassign': {
          addTarget(stmt.target);
          if (isName(stmt.target, '__all__')) {
            const values = stmt.op === '+=' ? literalStrings(stmt.value) : undefined;
            if (values === undefined) dynamicAll = true;
            else all = [...(all ?? []), ...values];
          }
          break;
        }
        case 'import':
          for (const alias of stmt.names) add(alias.asname ?? alias.name.split('.')[0] ?? '');
          break;
        case 'importfrom':
          if (stmt.names !== 'star') {
            for (const alias of stmt.names) add(alias.asname ?? alias.name);
          }
          break;
        case 'for':
          addTarget(stmt.target);
          visit(stmt.body);
          visit(stmt.orelse);
          break;
        case 'with':
          for (const item of stmt.items) {
            if (item.target) addTarget(item.target);
          }
          visit(stmt.body);
          break;
        case 'try':
          visit(stmt.body);
          for (const handler of stmt.handlers) {
            if (handler.name) add(handler.name);
            visit(handler.body);
          }
          visit(stmt.orelse);
          visit(stmt.finalbody);
          break;
        case 'if':
        case 'while':
          visit(stmt.body);
          visit(stmt.orelse);
          break;
        case 'match':
          for (const matchCase of stmt.cases) visit(matchCase.body);
          break;
        default:
          break;
      }
    }
  };

  visit(parseModuleRecovering(source).body);
  return { bound: [...bound], ...(!dynamicAll && all !== undefined ? { all } : {}) };
}

function isName(expr: Expr, id: string): boolean {
  return expr.kind === 'name' && expr.id === id;
}

/**
 * The string values of a list or tuple of plain string literals, or undefined for anything else.
 * A plain literal is one quoted pair with no escapes, so the value is read exactly.
 */
function literalStrings(expr: Expr): string[] | undefined {
  if (expr.kind !== 'list' && expr.kind !== 'tuple') return undefined;
  const values: string[] = [];
  for (const element of expr.elements) {
    if (element.kind !== 'constant' || element.type !== 'str') return undefined;
    const match = /^(['"])([^'"\\]*)\1$/.exec(element.raw);
    if (!match) return undefined;
    values.push(match[2] ?? '');
  }
  return values;
}
