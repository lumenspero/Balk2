/**
 * Shared readings of Python call expressions (V3 Phase 12.6): the qualified name a callee resolves
 * to through its import bindings, its arguments, and the value of a string literal.
 */
import type { CallArg, Expr } from './ast.js';
import { dottedName } from './expression-format.js';
import type { ModuleBinding } from './state-facts.js';

/** A plain or raw string literal with one quote style and no escapes. */
const LITERAL = /^[rRuU]?(['"])([^'"\\]*)\1$/;

/** `importlib.import_module`, `runpy.run_module` and the like, as a qualified name of their module. */
export function qualifiedName(
  func: Expr,
  bindings: ReadonlyMap<string, ModuleBinding> | undefined,
): string | undefined {
  if (func.kind === 'name') {
    const bound = bindings?.get(func.id);
    return bound?.kind === 'member' ? bound.name : undefined;
  }
  const text = dottedName(func);
  if (text === undefined) return undefined;
  const root = text.split('.')[0] ?? '';
  const bound = bindings?.get(root);
  return bound?.kind === 'external' ? `${bound.name}${text.slice(root.length)}` : undefined;
}

/** The argument at a position among the positional arguments, or the keyword argument of that name. */
export function argumentOf(
  args: readonly CallArg[],
  position: number,
  keyword: string,
): Expr | undefined {
  const positional = args.filter((arg) => arg.kind === 'positional');
  const found =
    positional[position] ?? args.find((arg) => arg.kind === 'keyword' && arg.name === keyword);
  return found?.value;
}

export function literalName(value: Expr): string | undefined {
  if (value.kind !== 'constant' || value.type !== 'str') return undefined;
  return LITERAL.exec(value.raw)?.[2];
}

export function segmentsOf(text: string): string[] {
  return text.split('.').filter((part) => part !== '');
}
