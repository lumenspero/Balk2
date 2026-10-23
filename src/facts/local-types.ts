import type { Confidence, SymbolType } from '../types.js';

/**
 * Local type rules (Phase 2.4), shared by Python and Rust. JS/TS uses them only when the checker
 * returns no type. A front end reads its declarations into `TypeExpr` values, and these functions
 * decide what type a binding has, with a confidence for each source.
 */

/** A type a binding can have: an internal symbol, or an external type name. */
export type TypeName =
  | { readonly kind: 'symbol'; readonly id: string }
  | { readonly kind: 'external'; readonly name: string };

/**
 * A type expression as written in the source. `wrapped` covers the wrappers that are peeled to
 * reach the receiver type. `self` is `Self` in Rust or the enclosing class in Python.
 */
export type TypeExpr =
  | { readonly kind: 'named'; readonly name: TypeName }
  | { readonly kind: 'wrapped'; readonly wrapper: string; readonly inner: TypeExpr }
  | { readonly kind: 'self' }
  | { readonly kind: 'unknown' };

/**
 * Wrappers peeled to reach the receiver type. Python: `Optional[...]`, `X | None` (as wrapper
 * `"X | None"`) and `Annotated[...]`. Rust: `&`, `&mut`, `Box`, `Rc` and `Arc`. `Option<T>` is not
 * peeled, because a method on it is not a method on `T`.
 */
export const PEELABLE_WRAPPERS: ReadonlySet<string> = new Set([
  'Optional',
  'X | None',
  'Annotated',
  '&',
  '&mut',
  'Box',
  'Rc',
  'Arc',
]);

/** Where a local type came from. */
export type LocalTypeSource = 'annotation' | 'constructor' | 'return-type';

/** The type of a binding, with its confidence and source. */
export interface LocalType {
  readonly name: TypeName;
  readonly confidence: Confidence;
  readonly source: LocalTypeSource;
  /** A literal a library constructor was given that names the instance, such as a signal's name (Phase 12.1). */
  readonly payload?: string;
}

/** A callable symbol, with what the rules need to know about it. */
export interface CallableSymbol {
  readonly id: string;
  readonly symbolType: SymbolType;
  /** The declared return type, when the front end read one. */
  readonly returnType?: TypeExpr;
  /** The type that `Self` means here: the class or inherent impl this method belongs to. */
  readonly ownerTypeId?: string;
}

/** Removes peelable wrappers until the type is named, `Self` or unknown. */
export function peelType(expr: TypeExpr): TypeExpr {
  let current = expr;
  while (current.kind === 'wrapped' && PEELABLE_WRAPPERS.has(current.wrapper)) {
    current = current.inner;
  }
  return current;
}

/** The type of an annotated parameter or variable: high confidence. */
export function annotationType(expr: TypeExpr): LocalType | undefined {
  const peeled = peelType(expr);
  if (peeled.kind !== 'named') return undefined;
  return { name: peeled.name, confidence: 'high', source: 'annotation' };
}

/** The result of calling a resolved class or struct is an instance of it: high confidence. */
export function constructorType(callee: CallableSymbol): LocalType | undefined {
  if (callee.symbolType !== 'class' && callee.symbolType !== 'struct') return undefined;
  return { name: { kind: 'symbol', id: callee.id }, confidence: 'high', source: 'constructor' };
}

/**
 * The result of calling a resolved function or method whose declared return type is an internal
 * type, or `Self`: medium confidence, because the call's return may be a subtype or a wrapper the
 * rules do not model. External return types give no type.
 */
export function returnType(callee: CallableSymbol): LocalType | undefined {
  if (callee.symbolType !== 'function' && callee.symbolType !== 'method') return undefined;
  if (callee.returnType === undefined) return undefined;

  const peeled = peelType(callee.returnType);
  if (peeled.kind === 'self') {
    if (callee.ownerTypeId === undefined) return undefined;
    return {
      name: { kind: 'symbol', id: callee.ownerTypeId },
      confidence: 'medium',
      source: 'return-type',
    };
  }
  if (peeled.kind === 'named' && peeled.name.kind === 'symbol') {
    return { name: peeled.name, confidence: 'medium', source: 'return-type' };
  }
  return undefined;
}

/**
 * The type of a name after a later binding. Rebinding to the same type keeps the earlier fact. A
 * rebinding to a different type, or to a value of unknown type, removes it. An unknown earlier type
 * stays unknown.
 */
export function afterRebinding(
  previous: LocalType | undefined,
  next: LocalType | undefined,
): LocalType | undefined {
  if (previous === undefined || next === undefined) return undefined;
  return sameTypeName(previous.name, next.name) && previous.payload === next.payload
    ? previous
    : undefined;
}

/** True when two type names refer to the same type. */
export function sameTypeName(a: TypeName, b: TypeName): boolean {
  if (a.kind === 'symbol' && b.kind === 'symbol') return a.id === b.id;
  if (a.kind === 'external' && b.kind === 'external') return a.name === b.name;
  return false;
}
