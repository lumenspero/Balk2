/**
 * Python syntax tree (V3 Phase 3.2a: expressions).
 *
 * Positions are 1-based, the same convention as SourceSpan. A node's span runs
 * from its first token to its last. Statement nodes are added in 3.2b.
 */

export interface Span {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

export interface DictEntry {
  /** `null` for a `**mapping` entry. */
  readonly key: Expr | null;
  readonly value: Expr;
}

export interface Comprehension {
  readonly target: Expr;
  readonly iter: Expr;
  readonly ifs: readonly Expr[];
  readonly isAsync: boolean;
}

export interface CallArg {
  readonly kind: 'positional' | 'keyword' | 'star' | 'double-star';
  /** Set for `name=value` keyword arguments only. */
  readonly name: string | null;
  readonly value: Expr;
  readonly span: Span;
}

export interface Param {
  /** `normal` is a named parameter, `vararg` is `*args`, `kwarg` is `**kwargs`. `bare-star` is a lone `*`, `slash` is `/`. */
  readonly kind: 'normal' | 'vararg' | 'kwarg' | 'bare-star' | 'slash';
  readonly name: string | null;
  readonly annotation: Expr | null;
  readonly default: Expr | null;
  readonly span: Span;
}

export type FStringPart =
  | { readonly kind: 'literal'; readonly raw: string; readonly span: Span }
  | {
      readonly kind: 'field';
      readonly expr: Expr;
      /** True for the `{x=}` self-documenting form. */
      readonly debug: boolean;
      readonly conversion: string | null;
      /** The format specification, when there is a top-level `:`. */
      readonly spec: readonly FStringPart[] | null;
      readonly span: Span;
    };

export type Expr =
  | { readonly kind: 'name'; readonly id: string; readonly span: Span }
  | {
      readonly kind: 'constant';
      readonly type: 'number' | 'str' | 'bytes' | 'bool' | 'none' | 'ellipsis';
      /** Source text. Adjacent string literals are joined with a space. */
      readonly raw: string;
      readonly span: Span;
    }
  | { readonly kind: 'fstring'; readonly parts: readonly FStringPart[]; readonly span: Span }
  | { readonly kind: 'attribute'; readonly value: Expr; readonly attr: string; readonly span: Span }
  | { readonly kind: 'subscript'; readonly value: Expr; readonly index: Expr; readonly span: Span }
  | {
      readonly kind: 'slice';
      readonly lower: Expr | null;
      readonly upper: Expr | null;
      readonly step: Expr | null;
      readonly span: Span;
    }
  | {
      readonly kind: 'call';
      readonly func: Expr;
      readonly args: readonly CallArg[];
      readonly span: Span;
    }
  | {
      readonly kind: 'binop';
      readonly op: string;
      readonly left: Expr;
      readonly right: Expr;
      readonly span: Span;
    }
  | { readonly kind: 'unaryop'; readonly op: string; readonly operand: Expr; readonly span: Span }
  | {
      readonly kind: 'boolop';
      readonly op: 'and' | 'or';
      readonly values: readonly Expr[];
      readonly span: Span;
    }
  | {
      readonly kind: 'compare';
      readonly left: Expr;
      readonly ops: readonly string[];
      readonly comparators: readonly Expr[];
      readonly span: Span;
    }
  | {
      readonly kind: 'ifexp';
      readonly test: Expr;
      readonly body: Expr;
      readonly orelse: Expr;
      readonly span: Span;
    }
  | {
      readonly kind: 'lambda';
      readonly params: readonly Param[];
      readonly body: Expr;
      readonly span: Span;
    }
  | {
      readonly kind: 'tuple' | 'list' | 'set';
      readonly elements: readonly Expr[];
      readonly span: Span;
    }
  | { readonly kind: 'dict'; readonly entries: readonly DictEntry[]; readonly span: Span }
  | {
      /** `element` is the key for a dict comprehension, and `value` is the dict value. */
      readonly kind: 'comprehension';
      readonly form: 'list' | 'set' | 'dict' | 'generator';
      readonly element: Expr;
      readonly value: Expr | null;
      readonly generators: readonly Comprehension[];
      readonly span: Span;
    }
  | { readonly kind: 'starred'; readonly value: Expr; readonly span: Span }
  | { readonly kind: 'namedexpr'; readonly target: Expr; readonly value: Expr; readonly span: Span }
  | { readonly kind: 'await'; readonly value: Expr; readonly span: Span }
  | { readonly kind: 'yield'; readonly value: Expr | null; readonly span: Span }
  | { readonly kind: 'yieldfrom'; readonly value: Expr; readonly span: Span };
