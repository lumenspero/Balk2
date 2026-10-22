/**
 * Python references (V3 Phase 5.6).
 *
 * Emits one `type` reference for each use of a repository symbol that names it rather than calls
 * it:
 * - annotations of parameters, returns and annotated assignments, including the names inside
 *   subscripts and unions (`Optional[C]`, `C | None`);
 * - string forward references inside annotations, parsed as expressions and resolved against
 *   module-level names;
 * - base classes;
 * - the second argument of `isinstance` and `issubclass`, including tuples of classes;
 * - `except` classes, including tuples;
 * - class patterns in `match` statements.
 *
 * The owner is the scope the expression is evaluated in. A dataclass or `NamedTuple` field
 * annotation is owned by the field's id (`<class id>.<field>`), from `fieldAnnotations` (5.2).
 *
 * Not resolved, and emitting no edge: names in string forward references that are bound only in a
 * class or function scope, and dotted names inside strings. Only the first argument of `Annotated`
 * is a type; the rest is metadata. The strings in `Literal[...]` are values, so they are never
 * references.
 */
import { ownerIdOf, type OwnerScope } from '../../facts/owner-rule.js';
import type { FactTarget } from '../../facts/types.js';
import type { Confidence, SourceSpan } from '../../types.js';
import type { Expr, Pattern, Stmt } from './ast.js';
import { exprChildren, stmtBlocks, stmtOwnExprs } from './ast-walk.js';
import { dottedName } from './expression-format.js';
import { parseModuleRecovering } from './statement-parser.js';
import {
  buildFileInfo,
  resolveBase,
  spanKey,
  toSourceSpan,
  type FileInfo,
  type InheritanceContext,
  type InheritanceFile,
} from './inheritance.js';
import { analyzePythonSymbols } from './symbols.js';

type Span = Expr['span'];
type CallExpr = Extract<Expr, { kind: 'call' }>;
type StrExpr = Extract<Expr, { kind: 'constant' }>;

export interface PythonReference {
  readonly filePath: string;
  /** The id of the scope the expression is evaluated in, or null for module-level code. */
  readonly owner: string | null;
  readonly span: SourceSpan;
  readonly target: FactTarget;
  readonly role: 'type';
  readonly confidence: Confidence;
}

export interface ReferenceAnalysis {
  readonly references: readonly PythonReference[];
}

interface RefContext {
  readonly info: FileInfo;
  readonly ctx: InheritanceContext;
  readonly declared: ReadonlySet<string>;
  /** Dataclass and `NamedTuple` field annotations, by the span of the annotation, to the field's id. */
  readonly fieldOwners: ReadonlyMap<string, string>;
  readonly out: PythonReference[];
}

function emit(rc: RefContext, span: Span, owner: string | null, target: FactTarget): void {
  rc.out.push({
    filePath: rc.info.filePath,
    owner,
    span: toSourceSpan(span, rc.info.filePath),
    target,
    role: 'type',
    confidence: 'high',
  });
}

/** The bare name of a subscripted typing form, such as `Literal` for `typing.Literal[...]`. */
function typingForm(e: Expr): string | undefined {
  return dottedName(e)?.replace(/^typing\./, '');
}

/** The text of a string literal without its prefix and quotes, or undefined for other text. */
function stringBody(raw: string): string | undefined {
  return /^[A-Za-z]*('''|"""|'|")([\s\S]*)\1$/.exec(raw)?.[2];
}

/** Names inside a string forward reference. Only bare names resolve through module bindings. */
function forwardNames(e: Expr, owner: string | null, span: Span, rc: RefContext): void {
  switch (e.kind) {
    case 'name': {
      const target = rc.ctx.symbols.resolveName(rc.info.filePath, e.id);
      if (target.kind === 'symbol') emit(rc, span, owner, target);
      return;
    }
    case 'subscript':
      forwardNames(e.value, owner, span, rc);
      if (typingForm(e.value) !== 'Literal') forwardNames(e.index, owner, span, rc);
      return;
    case 'tuple':
    case 'list':
      for (const el of e.elements) forwardNames(el, owner, span, rc);
      return;
    case 'binop':
      forwardNames(e.left, owner, span, rc);
      forwardNames(e.right, owner, span, rc);
      return;
    default:
      return;
  }
}

function forwardRef(e: StrExpr, owner: string | null, rc: RefContext): void {
  const text = stringBody(e.raw);
  if (text === undefined) return;
  const parsed = parseModuleRecovering(text);
  if (parsed.errors.length > 0 || parsed.body.length !== 1) return;
  const only = parsed.body[0];
  if (only?.kind !== 'expr') return;
  forwardNames(only.value, owner, e.span, rc);
}

/** Type positions: a name or dotted name, a subscript, a tuple, a union, or a string. */
function typesIn(e: Expr, owner: string | null, rc: RefContext): void {
  switch (e.kind) {
    case 'name':
    case 'attribute': {
      const target = resolveBase(e, rc.info, rc.ctx, rc.declared);
      if (target?.kind === 'symbol') emit(rc, e.span, owner, target);
      return;
    }
    case 'subscript': {
      typesIn(e.value, owner, rc);
      const form = typingForm(e.value);
      if (form === 'Literal') return;
      if (form === 'Annotated' && e.index.kind === 'tuple') {
        const first = e.index.elements[0];
        if (first !== undefined) typesIn(first, owner, rc);
        return;
      }
      typesIn(e.index, owner, rc);
      return;
    }
    case 'tuple':
    case 'list':
      for (const el of e.elements) typesIn(el, owner, rc);
      return;
    case 'binop':
      typesIn(e.left, owner, rc);
      typesIn(e.right, owner, rc);
      return;
    case 'constant':
      if (e.type === 'str') forwardRef(e, owner, rc);
      return;
    default:
      return;
  }
}

/** An annotation is owned by its field when it is a dataclass or `NamedTuple` field. */
function annotationRefs(annotation: Expr, owner: string | null, rc: RefContext): void {
  typesIn(annotation, rc.fieldOwners.get(spanKey(annotation.span)) ?? owner, rc);
}

function patternTypes(p: Pattern, owner: string | null, rc: RefContext): void {
  switch (p.kind) {
    case 'class':
      typesIn(p.cls, owner, rc);
      for (const q of p.positional) patternTypes(q, owner, rc);
      for (const k of p.keywords) patternTypes(k.pattern, owner, rc);
      return;
    case 'sequence':
      for (const q of p.elements) patternTypes(q, owner, rc);
      return;
    case 'mapping':
      for (const entry of p.entries) patternTypes(entry.pattern, owner, rc);
      return;
    case 'or':
      for (const q of p.alternatives) patternTypes(q, owner, rc);
      return;
    case 'as':
      patternTypes(p.pattern, owner, rc);
      return;
    default:
      return;
  }
}

/** `isinstance(x, C)` and `issubclass(x, C)`, where the second argument names classes. */
function typeCheckRefs(c: CallExpr, owner: string | null, rc: RefContext): void {
  const func = c.func;
  if (func.kind !== 'name' || (func.id !== 'isinstance' && func.id !== 'issubclass')) return;
  if (rc.info.uses.get(spanKey(func.span))?.resolution.kind !== 'builtin') return;
  const classes = c.args[1];
  if (classes !== undefined) typesIn(classes.value, owner, rc);
}

function scanCalls(e: Expr, visit: (c: CallExpr) => void): void {
  if (e.kind === 'call') visit(e);
  for (const child of exprChildren(e)) scanCalls(child, visit);
}

function statementRefs(st: Stmt, owner: string | null, rc: RefContext): void {
  switch (st.kind) {
    case 'annassign':
      annotationRefs(st.annotation, owner, rc);
      break;
    case 'funcdef':
      for (const p of st.params) if (p.annotation !== null) annotationRefs(p.annotation, owner, rc);
      if (st.returns !== null) annotationRefs(st.returns, owner, rc);
      break;
    case 'classdef':
      for (const b of st.bases) typesIn(b.value, owner, rc);
      break;
    case 'try':
      for (const h of st.handlers) if (h.type !== null) typesIn(h.type, owner, rc);
      break;
    case 'match':
      for (const c of st.cases) patternTypes(c.pattern, owner, rc);
      break;
    default:
      break;
  }
  for (const root of stmtOwnExprs(st)) scanCalls(root, (c) => typeCheckRefs(c, owner, rc));
}

function walkStmts(stmts: readonly Stmt[], chain: readonly OwnerScope[], rc: RefContext): void {
  for (const st of stmts) {
    const owner = chain.length === 0 ? null : ownerIdOf(rc.info.filePath, chain);
    statementRefs(st, owner, rc);
    if (st.kind === 'funcdef') {
      const inClass = chain[chain.length - 1]?.kind === 'class';
      walkStmts(st.body, [...chain, { kind: inClass ? 'method' : 'function', name: st.name }], rc);
    } else if (st.kind === 'classdef') {
      walkStmts(st.body, [...chain, { kind: 'class', name: st.name }], rc);
    }
    for (const block of stmtBlocks(st)) walkStmts(block, chain, rc);
  }
}

/** Analyzes the type references in a set of Python files. Never throws on malformed input. */
export function analyzePythonReferences(
  files: readonly InheritanceFile[],
  ctx: InheritanceContext,
): ReferenceAnalysis {
  const analyzed = files.map((file) => ({ file, info: buildFileInfo(file, ctx) }));
  const declared = new Set<string>();
  for (const { info } of analyzed) {
    for (const d of info.declarations) declared.add(d.id);
  }
  const out: PythonReference[] = [];
  for (const { file, info } of analyzed) {
    const fieldOwners = new Map<string, string>();
    for (const f of analyzePythonSymbols(file.source, file.filePath).fieldAnnotations) {
      fieldOwners.set(spanKey(f.annotation.span), f.owner);
    }
    walkStmts(info.body, [], { info, ctx, declared, fieldOwners, out });
  }
  return { references: out };
}
