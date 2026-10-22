/**
 * Python symbols and owners (V3 Phase 5.2).
 *
 * Declares the symbols of one module as `Declaration` facts. Identity and ownership follow the
 * shared rules: ids come from `ownerIdOf` (facts/owner-rule.ts), so `Outer.Inner.method` and a
 * function nested in a function are named the same way the other languages name them.
 *
 * Declared:
 * - Classes (`class`), including nested classes, which are `Outer.Inner`.
 * - Functions at module level or nested in a function (`function`).
 * - Functions defined directly in a class body (`method`), including `@staticmethod`,
 *   `@classmethod` and `@property`.
 * - Module-level variables. A name in UPPER_CASE, or annotated `Final`, is a `constant`; any other
 *   module-level assignment is a `variable`. Only module level counts: a name assigned inside a
 *   function is local, and a class-body assignment is an attribute, not a symbol.
 * - PEP 695 type aliases (`type`).
 * - Fields of dataclasses and `NamedTuple` classes, as `variable` symbols owned by their class.
 *   Each field's annotation is returned for the references phase (5.6), not resolved here.
 *
 * A definition inside `if`, `try`, `match` and similar blocks is still declared, and records the
 * text of each enclosing condition. Repeated definitions of one id stay separate declarations here;
 * `groupSymbols` merges them.
 *
 * Owners: a module-level declaration has no owner. A declaration in a class body is owned by the
 * class. A declaration in a function or method is owned by that function or method.
 */
import type { Declaration, Visibility } from '../../facts/types.js';
import type { SourceSpan } from '../../types.js';
import { ownerIdOf } from '../../facts/owner-rule.js';
import type { OwnerScope } from '../../facts/owner-rule.js';
import type { Expr, Span, Stmt } from './ast.js';
import { dottedName, formatExpr } from './expression-format.js';
import { moduleNames } from './modules/module-names.js';
import { parseModuleRecovering } from './statement-parser.js';

const CONSTANT_NAME = /^_*[A-Z][A-Z0-9_]*$/;

/** The annotation of a dataclass or `NamedTuple` field, for the references phase. */
export interface PythonFieldAnnotation {
  /** The field's symbol id, `<class id>.<field>`. */
  readonly owner: string;
  readonly annotation: Expr;
  readonly span: SourceSpan;
}

export interface PythonSymbolAnalysis {
  /** One per definition site. The same id can appear more than once (see `groupSymbols`). */
  readonly declarations: readonly Declaration[];
  readonly fieldAnnotations: readonly PythonFieldAnnotation[];
}

/**
 * Declares the symbols of one Python module. Never throws on malformed input: syntax errors are
 * recovered from by the statement parser and reported by the front end, not here.
 */
export function analyzePythonSymbols(source: string, filePath: string): PythonSymbolAnalysis {
  const { body } = parseModuleRecovering(source);
  const walker = new SymbolWalker(filePath, moduleNames(source).all);
  walker.block(body, [], []);
  return { declarations: walker.declarations, fieldAnnotations: walker.fields };
}

/** Groups declarations by id. Each group is one symbol, with every definition site it has. */
export function groupSymbols(
  declarations: readonly Declaration[],
): Map<string, readonly Declaration[]> {
  const groups = new Map<string, Declaration[]>();
  for (const decl of declarations) {
    const group = groups.get(decl.id);
    if (group === undefined) groups.set(decl.id, [decl]);
    else group.push(decl);
  }
  return groups;
}

function toSourceSpan(span: Span, filePath: string): SourceSpan {
  return {
    filePath,
    startLine: span.line,
    startColumn: span.column,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}

function visibilityOf(name: string): Visibility {
  const dunder = name.startsWith('__') && name.endsWith('__');
  return name.startsWith('_') && !dunder ? 'private' : 'public';
}

function innermostIsClass(chain: readonly OwnerScope[]): boolean {
  return chain[chain.length - 1]?.kind === 'class';
}

/** The name an annotation or base is written with, without `typing.`, and without subscripts. */
function bareName(e: Expr): string | undefined {
  const name = dottedName(e.kind === 'subscript' ? e.value : e);
  return name?.replace(/^typing\./, '');
}

function isFinal(annotation: Expr): boolean {
  return bareName(annotation) === 'Final';
}

function isDataclassLike(st: Extract<Stmt, { kind: 'classdef' }>): boolean {
  const decorated = st.decorators.some((d) => {
    const name = dottedName(d.kind === 'call' ? d.func : d);
    return name === 'dataclass' || name === 'dataclasses.dataclass';
  });
  const named = st.bases.some((b) => bareName(b.value) === 'NamedTuple');
  return decorated || named;
}

class SymbolWalker {
  readonly declarations: Declaration[] = [];
  readonly fields: PythonFieldAnnotation[] = [];

  constructor(
    private readonly filePath: string,
    private readonly all: readonly string[] | undefined,
  ) {}

  block(stmts: readonly Stmt[], chain: readonly OwnerScope[], conditions: readonly string[]): void {
    for (const st of stmts) this.stmt(st, chain, conditions);
  }

  private stmt(st: Stmt, chain: readonly OwnerScope[], conditions: readonly string[]): void {
    switch (st.kind) {
      case 'funcdef': {
        const scope: OwnerScope = {
          kind: innermostIsClass(chain) ? 'method' : 'function',
          name: st.name,
        };
        const id = ownerIdOf(this.filePath, [...chain, scope]);
        this.declare(
          id,
          st.name,
          scope.kind === 'method' ? 'method' : 'function',
          st.span,
          chain,
          conditions,
        );
        this.block(st.body, [...chain, scope], []);
        return;
      }
      case 'classdef': {
        const scope: OwnerScope = { kind: 'class', name: st.name };
        const id = ownerIdOf(this.filePath, [...chain, scope]);
        this.declare(id, st.name, 'class', st.span, chain, conditions);
        this.block(st.body, [...chain, scope], []);
        if (isDataclassLike(st)) this.fieldsOf(st, id);
        return;
      }
      case 'typealias':
        if (chain.length === 0) {
          this.declare(this.moduleId(st.name), st.name, 'type', st.span, chain, conditions);
        }
        return;
      case 'assign':
        if (chain.length === 0) {
          for (const target of st.targets) this.moduleTarget(target, st.span, conditions);
        }
        return;
      case 'annassign':
        if (chain.length === 0 && st.target.kind === 'name') {
          this.moduleVariable(st.target.id, st.span, conditions, isFinal(st.annotation));
        }
        return;
      case 'if':
        this.block(st.body, chain, [...conditions, formatExpr(st.test)]);
        this.block(st.orelse, chain, [...conditions, `not (${formatExpr(st.test)})`]);
        return;
      case 'while':
      case 'for':
        this.block(st.body, chain, conditions);
        this.block(st.orelse, chain, conditions);
        return;
      case 'with':
        this.block(st.body, chain, conditions);
        return;
      case 'try':
        this.block(st.body, chain, [...conditions, 'try']);
        for (const handler of st.handlers) {
          const label = handler.type === null ? 'except' : `except ${formatExpr(handler.type)}`;
          this.block(handler.body, chain, [...conditions, label]);
        }
        this.block(st.orelse, chain, conditions);
        this.block(st.finalbody, chain, conditions);
        return;
      case 'match':
        for (const c of st.cases) {
          this.block(c.body, chain, [...conditions, `match ${formatExpr(st.subject)}`]);
        }
        return;
      default:
        return;
    }
  }

  /** Dataclass and NamedTuple fields: the annotated names directly in the class body. */
  private fieldsOf(st: Extract<Stmt, { kind: 'classdef' }>, classId: string): void {
    for (const member of st.body) {
      if (member.kind !== 'annassign' || member.target.kind !== 'name') continue;
      const name = member.target.id;
      const fieldId = `${classId}.${name}`;
      this.declare(fieldId, name, 'variable', member.span, [], [], classId);
      this.fields.push({
        owner: fieldId,
        annotation: member.annotation,
        span: toSourceSpan(member.span, this.filePath),
      });
    }
  }

  private moduleTarget(target: Expr, span: Span, conditions: readonly string[]): void {
    if (target.kind === 'name') {
      this.moduleVariable(target.id, span, conditions, false);
    } else if (target.kind === 'tuple' || target.kind === 'list') {
      for (const element of target.elements) this.moduleTarget(element, span, conditions);
    } else if (target.kind === 'starred') {
      this.moduleTarget(target.value, span, conditions);
    }
  }

  private moduleVariable(
    name: string,
    span: Span,
    conditions: readonly string[],
    final: boolean,
  ): void {
    const symbolType = final || CONSTANT_NAME.test(name) ? 'constant' : 'variable';
    this.declare(this.moduleId(name), name, symbolType, span, [], conditions);
  }

  private moduleId(name: string): string {
    return `${this.filePath}:${name}`;
  }

  /**
   * Adds one declaration. The owner is the innermost enclosing scope, or `ownerOverride` when a
   * field is declared under its class.
   */
  private declare(
    id: string,
    name: string,
    symbolType: Declaration['symbolType'],
    span: Span,
    chain: readonly OwnerScope[],
    conditions: readonly string[],
    ownerOverride?: string,
  ): void {
    const visibility = visibilityOf(name);
    const owner = ownerOverride ?? (chain.length === 0 ? null : ownerIdOf(this.filePath, chain));
    const exported =
      chain.length === 0 &&
      ownerOverride === undefined &&
      (this.all !== undefined ? this.all.includes(name) : visibility === 'public');
    this.declarations.push({
      kind: 'declaration',
      filePath: this.filePath,
      span: toSourceSpan(span, this.filePath),
      id,
      name,
      symbolType,
      owner,
      visibility,
      exported,
      ...(conditions.length > 0 ? { condition: conditions.join(' and ') } : {}),
    });
  }
}
