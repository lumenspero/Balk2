import type { Expr } from './ast.js';
import { PythonSyntaxError } from './cursor.js';

/** How an expression kind is named in "cannot assign to ..." messages, following CPython's wording. */
export function describeExpr(e: Expr): string {
  switch (e.kind) {
    case 'constant':
      if (e.type === 'str' || e.type === 'bytes' || e.type === 'number') return 'literal';
      if (e.type === 'ellipsis') return 'Ellipsis';
      return e.raw;
    case 'fstring':
      return 'f-string expression';
    case 'call':
      return 'function call';
    case 'binop':
    case 'unaryop':
    case 'boolop':
    case 'compare':
    case 'slice':
      return 'expression';
    case 'ifexp':
      return 'conditional expression';
    case 'lambda':
      return 'lambda';
    case 'dict':
      return 'dict literal';
    case 'set':
      return 'set display';
    case 'comprehension':
      return `${e.form === 'generator' ? 'generator' : e.form} comprehension`;
    case 'namedexpr':
      return 'named expression';
    case 'await':
      return 'await expression';
    case 'yield':
    case 'yieldfrom':
      return 'yield expression';
    default:
      return e.kind;
  }
}

/** Checks that `target` can be assigned to, or deleted. Throws PythonSyntaxError otherwise. */
export function checkTarget(target: Expr, action: 'assign to' | 'delete' = 'assign to'): void {
  switch (target.kind) {
    case 'name':
    case 'attribute':
    case 'subscript':
      return;
    case 'starred':
      if (action === 'delete') {
        throw new PythonSyntaxError('cannot delete starred', target.span.line, target.span.column);
      }
      checkTarget(target.value, action);
      return;
    case 'tuple':
    case 'list':
      target.elements.forEach((element) => checkTarget(element, action));
      return;
    default:
      throw new PythonSyntaxError(
        `cannot ${action} ${describeExpr(target)}`,
        target.span.line,
        target.span.column,
      );
  }
}

/** An augmented or annotated assignment takes exactly one target, not a tuple or list. */
export function checkSingleTarget(target: Expr, form: 'augmented' | 'annotated'): void {
  if (target.kind === 'tuple' || target.kind === 'list') {
    const message =
      form === 'augmented'
        ? `'${target.kind}' is an illegal expression for augmented assignment`
        : `only single target (not ${target.kind}) can be annotated`;
    throw new PythonSyntaxError(message, target.span.line, target.span.column);
  }
  checkTarget(target);
}
