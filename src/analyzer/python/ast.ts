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

// ── Patterns (match statement) ──────────────────────────────────────────────

export type Pattern =
  /** A literal, including None, True, False, signed numbers and strings. */
  | { readonly kind: 'literal'; readonly value: Expr; readonly span: Span }
  /** A dotted name such as `Color.RED`, which compares by equality. */
  | { readonly kind: 'value'; readonly value: Expr; readonly span: Span }
  /** A bare name, which binds the subject. */
  | { readonly kind: 'capture'; readonly name: string; readonly span: Span }
  /** `_`, which matches anything and binds nothing. */
  | { readonly kind: 'wildcard'; readonly span: Span }
  /** `*name` or `*_` inside a sequence pattern. */
  | { readonly kind: 'star'; readonly name: string | null; readonly span: Span }
  | { readonly kind: 'sequence'; readonly elements: readonly Pattern[]; readonly span: Span }
  | {
      readonly kind: 'mapping';
      readonly entries: readonly { readonly key: Expr; readonly pattern: Pattern }[];
      readonly rest: string | null;
      readonly span: Span;
    }
  | {
      readonly kind: 'class';
      readonly cls: Expr;
      readonly positional: readonly Pattern[];
      readonly keywords: readonly { readonly name: string; readonly pattern: Pattern }[];
      readonly span: Span;
    }
  | { readonly kind: 'or'; readonly alternatives: readonly Pattern[]; readonly span: Span }
  | { readonly kind: 'as'; readonly pattern: Pattern; readonly name: string; readonly span: Span };

// ── Statements ──────────────────────────────────────────────────────────────

export interface Alias {
  readonly name: string;
  readonly asname: string | null;
  readonly span: Span;
}

export interface TypeParam {
  readonly kind: 'typevar' | 'typevartuple' | 'paramspec';
  readonly name: string;
  readonly bound: Expr | null;
  readonly default: Expr | null;
  readonly span: Span;
}

export interface ExceptHandler {
  readonly type: Expr | null;
  readonly name: string | null;
  /** `except*` */
  readonly isStar: boolean;
  readonly body: readonly Stmt[];
  readonly span: Span;
}

export interface WithItem {
  readonly context: Expr;
  readonly target: Expr | null;
}

export interface MatchCase {
  readonly pattern: Pattern;
  readonly guard: Expr | null;
  readonly body: readonly Stmt[];
  readonly span: Span;
}

export type Stmt =
  | { readonly kind: 'expr'; readonly value: Expr; readonly span: Span }
  | {
      readonly kind: 'assign';
      readonly targets: readonly Expr[];
      readonly value: Expr;
      readonly span: Span;
    }
  | {
      readonly kind: 'augassign';
      readonly target: Expr;
      readonly op: string;
      readonly value: Expr;
      readonly span: Span;
    }
  | {
      readonly kind: 'annassign';
      readonly target: Expr;
      readonly annotation: Expr;
      readonly value: Expr | null;
      readonly span: Span;
    }
  | { readonly kind: 'return'; readonly value: Expr | null; readonly span: Span }
  | { readonly kind: 'delete'; readonly targets: readonly Expr[]; readonly span: Span }
  | { readonly kind: 'pass' | 'break' | 'continue'; readonly span: Span }
  | {
      readonly kind: 'raise';
      readonly exc: Expr | null;
      readonly cause: Expr | null;
      readonly span: Span;
    }
  | { readonly kind: 'global' | 'nonlocal'; readonly names: readonly string[]; readonly span: Span }
  | { readonly kind: 'assert'; readonly test: Expr; readonly msg: Expr | null; readonly span: Span }
  | { readonly kind: 'import'; readonly names: readonly Alias[]; readonly span: Span }
  | {
      readonly kind: 'importfrom';
      /** The dotted module name, or null for `from . import x`. */
      readonly module: string | null;
      /** The number of leading dots. */
      readonly level: number;
      readonly names: readonly Alias[] | 'star';
      readonly span: Span;
    }
  | {
      readonly kind: 'funcdef';
      readonly name: string;
      readonly typeParams: readonly TypeParam[];
      readonly params: readonly Param[];
      readonly returns: Expr | null;
      readonly body: readonly Stmt[];
      readonly decorators: readonly Expr[];
      readonly isAsync: boolean;
      readonly span: Span;
    }
  | {
      readonly kind: 'classdef';
      readonly name: string;
      readonly typeParams: readonly TypeParam[];
      readonly bases: readonly CallArg[];
      readonly body: readonly Stmt[];
      readonly decorators: readonly Expr[];
      readonly span: Span;
    }
  | {
      readonly kind: 'if';
      readonly test: Expr;
      readonly body: readonly Stmt[];
      readonly orelse: readonly Stmt[];
      readonly span: Span;
    }
  | {
      readonly kind: 'while';
      readonly test: Expr;
      readonly body: readonly Stmt[];
      readonly orelse: readonly Stmt[];
      readonly span: Span;
    }
  | {
      readonly kind: 'for';
      readonly target: Expr;
      readonly iter: Expr;
      readonly body: readonly Stmt[];
      readonly orelse: readonly Stmt[];
      readonly isAsync: boolean;
      readonly span: Span;
    }
  | {
      readonly kind: 'with';
      readonly items: readonly WithItem[];
      readonly body: readonly Stmt[];
      readonly isAsync: boolean;
      readonly span: Span;
    }
  | {
      readonly kind: 'try';
      readonly body: readonly Stmt[];
      readonly handlers: readonly ExceptHandler[];
      readonly orelse: readonly Stmt[];
      readonly finalbody: readonly Stmt[];
      readonly span: Span;
    }
  | {
      readonly kind: 'match';
      readonly subject: Expr;
      readonly cases: readonly MatchCase[];
      readonly span: Span;
    }
  | {
      readonly kind: 'typealias';
      readonly name: string;
      readonly typeParams: readonly TypeParam[];
      readonly value: Expr;
      readonly span: Span;
    };
