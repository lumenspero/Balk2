/**
 * Child traversal for the Python statement and expression AST (V3 Phase 5.4a).
 *
 * Front-end checkpoints walk expressions with these helpers, so each one visits the same children
 * and none of them misses a form. Function and class bodies are not returned by `stmtBlocks`,
 * because a body starts a new owner, and the caller decides how to visit it.
 */
import type { Expr, FStringPart, Stmt } from './ast.js';

function fstringExprs(parts: readonly FStringPart[]): Expr[] {
  const out: Expr[] = [];
  for (const part of parts) {
    if (part.kind !== 'field') continue;
    out.push(part.expr);
    if (part.spec !== null) out.push(...fstringExprs(part.spec));
  }
  return out;
}

/** The direct child expressions of an expression, in source order. */
export function exprChildren(e: Expr): Expr[] {
  switch (e.kind) {
    case 'name':
    case 'constant':
      return [];
    case 'fstring':
      return fstringExprs(e.parts);
    case 'attribute':
    case 'starred':
    case 'await':
    case 'yieldfrom':
      return [e.value];
    case 'subscript':
      return [e.value, e.index];
    case 'slice':
      return [e.lower, e.upper, e.step].filter((x): x is Expr => x !== null);
    case 'call':
      return [e.func, ...e.args.map((a) => a.value)];
    case 'binop':
      return [e.left, e.right];
    case 'unaryop':
      return [e.operand];
    case 'boolop':
      return [...e.values];
    case 'compare':
      return [e.left, ...e.comparators];
    case 'ifexp':
      return [e.test, e.body, e.orelse];
    case 'lambda':
      return [...e.params.flatMap((p) => (p.default === null ? [] : [p.default])), e.body];
    case 'tuple':
    case 'list':
    case 'set':
      return [...e.elements];
    case 'dict':
      return e.entries.flatMap((entry) =>
        entry.key === null ? [entry.value] : [entry.key, entry.value],
      );
    case 'comprehension':
      return [
        e.element,
        ...(e.value === null ? [] : [e.value]),
        ...e.generators.flatMap((g) => [g.target, g.iter, ...g.ifs]),
      ];
    case 'namedexpr':
      return [e.target, e.value];
    case 'yield':
      return e.value === null ? [] : [e.value];
  }
}

/**
 * The expressions a statement evaluates itself, not counting the statements nested in its blocks.
 * A `def` or `class` contributes its decorators, defaults, annotations and bases, which run in the
 * enclosing scope. Its body is reached through `stmtBlocks`' caller, not here.
 */
export function stmtOwnExprs(st: Stmt): Expr[] {
  switch (st.kind) {
    case 'expr':
      return [st.value];
    case 'assign':
      return [st.value, ...st.targets];
    case 'augassign':
      return [st.target, st.value];
    case 'annassign':
      return [st.annotation, ...(st.value === null ? [] : [st.value]), st.target];
    case 'return':
      return st.value === null ? [] : [st.value];
    case 'delete':
      return [...st.targets];
    case 'raise':
      return [st.exc, st.cause].filter((x): x is Expr => x !== null);
    case 'assert':
      return [st.test, st.msg].filter((x): x is Expr => x !== null);
    case 'if':
    case 'while':
      return [st.test];
    case 'for':
      return [st.iter, st.target];
    case 'with':
      return st.items.flatMap((item) =>
        item.target === null ? [item.context] : [item.context, item.target],
      );
    case 'try':
      return st.handlers.flatMap((h) => (h.type === null ? [] : [h.type]));
    case 'match':
      return [st.subject, ...st.cases.flatMap((c) => (c.guard === null ? [] : [c.guard]))];
    case 'typealias':
      return [st.value];
    case 'funcdef':
      return [
        ...st.decorators,
        ...st.params.flatMap((p) => [
          ...(p.default === null ? [] : [p.default]),
          ...(p.annotation === null ? [] : [p.annotation]),
        ]),
        ...(st.returns === null ? [] : [st.returns]),
      ];
    case 'classdef':
      return [...st.decorators, ...st.bases.map((b) => b.value)];
    default:
      return [];
  }
}

/** The nested statement blocks of a compound statement. A `def` or `class` body is not one. */
export function stmtBlocks(st: Stmt): (readonly Stmt[])[] {
  switch (st.kind) {
    case 'if':
    case 'while':
    case 'for':
      return [st.body, st.orelse];
    case 'with':
      return [st.body];
    case 'try':
      return [st.body, ...st.handlers.map((h) => h.body), st.orelse, st.finalbody];
    case 'match':
      return st.cases.map((c) => c.body);
    default:
      return [];
  }
}
