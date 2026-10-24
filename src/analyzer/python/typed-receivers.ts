/**
 * Python typed receivers (V3 Phase 5.4c).
 *
 * Gives a method call's receiver a type through the shared local-type rules (facts/local-types.ts,
 * Phase 2.4):
 * - an annotated parameter or variable: high;
 * - a variable whose every binding is a call to the same repository class: high;
 * - a call to a repository function whose return annotation is a repository class or `Self`:
 *   medium;
 * - a constructor call used directly as the receiver: high.
 *
 * `Optional[X]`, `X | None` and `Annotated[X, ...]` are peeled to reach the class.
 *
 * A name's type applies to its whole scope, not to one point in its flow. Every binding site of
 * the name must be one of the forms above and must give the same type; otherwise the name has no
 * type. Each binding site is counted against the scope analysis (5.1), so a binding this collector
 * does not model, such as a `match` capture, leaves the name untyped rather than typed wrongly.
 *
 * Not modeled: string forward references, `Self` written as a string, instance attributes
 * (`self.x`), class-level annotations, and types that pass through another variable.
 */
import { ownerIdOf, type OwnerScope } from '../../facts/owner-rule.js';
import {
  annotationType,
  constructorType,
  returnType,
  sameTypeName,
  type CallableSymbol,
  type LocalType,
  type TypeExpr,
} from '../../facts/local-types.js';
import type { Confidence, SymbolType } from '../../types.js';
import type { Expr, Stmt } from './ast.js';
import { exprChildren, stmtBlocks, stmtOwnExprs } from './ast-walk.js';
import { dottedName } from './expression-format.js';
import {
  importedNameOf,
  resolveBase,
  spanKey,
  type FileInfo,
  type InheritanceContext,
} from './inheritance.js';
import type { Scope } from './scopes.js';

/** Local types by scope, and the return types of repository callables. */
export interface TypeIndex {
  readonly callables: ReadonlyMap<string, CallableSymbol>;
  /** Typed names, keyed by `scopeKey`. A name with no entry has no type. */
  readonly locals: ReadonlyMap<string, ReadonlyMap<string, LocalType>>;
  /** Names bound only to `functools.partial(f)`, keyed by `scopeKey`, with the id of `f`. */
  readonly partials: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

interface Source {
  readonly name: string;
  readonly type: LocalType | undefined;
  /** The function a `functools.partial` binding refers to, when the binding is one. */
  readonly callee?: string | undefined;
}

const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/** A stable key for a scope within the repository. */
export function scopeKey(file: string, scope: Scope): string {
  if (scope.span === null) return `${file}|module`;
  return `${file}|${scope.kind}|${scope.span.line}:${scope.span.column}`;
}

function topLevel(dotted: string): string {
  const dot = dotted.indexOf('.');
  return dot < 0 ? dotted : dotted.slice(0, dot);
}

/** True when `e` names `typing.<name>`, or `<name>` imported from typing. */
function isTypingName(e: Expr, info: FileInfo, name: string): boolean {
  const dotted = dottedName(e);
  if (dotted === `typing.${name}`) return true;
  if (dotted !== name) return false;
  const imp = info.imported.get(name);
  return imp?.module === 'typing' && imp.name === name;
}

/** The wrapper names peeled to reach a class: `Optional` and `Annotated`. */
function wrapperName(e: Expr): 'Optional' | 'Annotated' | undefined {
  const dotted = dottedName(e)?.replace(/^typing\./, '');
  return dotted === 'Optional' || dotted === 'Annotated' ? dotted : undefined;
}

function isNone(e: Expr): boolean {
  return e.kind === 'constant' && e.type === 'none';
}

/** Reads an annotation as a type expression. Unrecognized forms are unknown. */
export function typeExprOf(
  e: Expr,
  info: FileInfo,
  ctx: InheritanceContext,
  declared: ReadonlySet<string>,
): TypeExpr {
  switch (e.kind) {
    case 'name':
    case 'attribute': {
      if (isTypingName(e, info, 'Self')) return { kind: 'self' };
      const target = resolveBase(e, info, ctx, declared);
      if (target?.kind === 'symbol') {
        return { kind: 'named', name: { kind: 'symbol', id: target.id } };
      }
      if (target?.kind === 'external') {
        const name = importedNameOf(e, info) ?? target.name;
        return { kind: 'named', name: { kind: 'external', name } };
      }
      return { kind: 'unknown' };
    }
    case 'subscript': {
      const wrapper = wrapperName(e.value);
      if (wrapper === undefined) return { kind: 'unknown' };
      const inner = e.index.kind === 'tuple' ? e.index.elements[0] : e.index;
      if (inner === undefined) return { kind: 'unknown' };
      return { kind: 'wrapped', wrapper, inner: typeExprOf(inner, info, ctx, declared) };
    }
    case 'binop': {
      if (e.op !== '|') return { kind: 'unknown' };
      const other = isNone(e.right) ? e.left : isNone(e.left) ? e.right : undefined;
      if (other === undefined) return { kind: 'unknown' };
      return {
        kind: 'wrapped',
        wrapper: 'X | None',
        inner: typeExprOf(other, info, ctx, declared),
      };
    }
    default:
      return { kind: 'unknown' };
  }
}

/** The value of a plain, single-line string literal with no escapes or joins, or undefined. */
export function plainStringValue(e: Expr): string | undefined {
  if (e.kind !== 'constant' || e.type !== 'str') return undefined;
  const match = /^[rRuU]?(?:'([^'\\\n]*)'|"([^"\\\n]*)")$/.exec(e.raw);
  if (match === null) return undefined;
  return match[1] ?? match[2];
}

/** The type of a value, when it is a call the rules type: a constructor or a typed function. */
export function typeOfValue(
  e: Expr,
  info: FileInfo,
  ctx: InheritanceContext,
  declared: ReadonlySet<string>,
  types: ReadonlyMap<string, SymbolType>,
  callables: ReadonlyMap<string, CallableSymbol>,
): LocalType | undefined {
  if (e.kind === 'dict') {
    return {
      name: { kind: 'external', name: 'builtins.dict' },
      confidence: 'high',
      source: 'constructor',
    };
  }
  if (e.kind !== 'call') return undefined;
  const target = resolveBase(e.func, info, ctx, declared);
  if (target?.kind === 'external' && target.name === 'builtins') {
    if (dottedName(e.func) !== 'dict') return undefined;
    return {
      name: { kind: 'external', name: 'builtins.dict' },
      confidence: 'high',
      source: 'constructor',
    };
  }
  if (target?.kind === 'external') {
    // An imported name may be a class or a function, so its result is medium. The name is the one
    // the import gives, so library types can be matched (Phase 12.1).
    const name = importedNameOf(e.func, info);
    if (name === undefined) return undefined;
    const first = e.args[0];
    const payload = first?.kind === 'positional' ? plainStringValue(first.value) : undefined;
    return {
      name: { kind: 'external', name },
      confidence: 'medium',
      source: 'constructor',
      ...(payload === undefined ? {} : { payload }),
    };
  }
  if (target?.kind !== 'symbol') return undefined;
  const symbolType = types.get(target.id);
  if (symbolType === undefined) return undefined;
  const callable: CallableSymbol = callables.get(target.id) ?? { id: target.id, symbolType };
  return constructorType(callable) ?? returnType(callable);
}

/** The type of a name at its use, from the scope its binding lives in. */
export function localTypeOf(
  e: Extract<Expr, { kind: 'name' }>,
  info: FileInfo,
  index: TypeIndex,
): LocalType | undefined {
  const resolution = info.uses.get(spanKey(e.span))?.resolution;
  if (resolution?.kind !== 'scope') return undefined;
  const scope = info.scopes.scopes.find((s) => s.id === resolution.scope);
  if (scope === undefined) return undefined;
  return index.locals.get(scopeKey(info.filePath, scope))?.get(e.id);
}

/** True when `e` names `functools.partial`, by the module's own import. */
function isPartialName(e: Expr, info: FileInfo): boolean {
  const dotted = dottedName(e);
  if (dotted === 'functools.partial') {
    const imp = info.imported.get('functools');
    return imp?.module === 'functools' && imp.name === null;
  }
  if (dotted === 'partial') {
    const imp = info.imported.get('partial');
    return imp?.module === 'functools' && imp.name === 'partial';
  }
  return false;
}

/**
 * The id of `f` when `e` is `functools.partial(f, ...)` and `f` is a repository function or
 * method. Anything else is undefined.
 */
export function partialTargetOf(
  e: Expr,
  info: FileInfo,
  ctx: InheritanceContext,
  declared: ReadonlySet<string>,
  types: ReadonlyMap<string, SymbolType>,
): string | undefined {
  if (e.kind !== 'call' || !isPartialName(e.func, info)) return undefined;
  const first = e.args[0];
  if (first === undefined || first.kind !== 'positional') return undefined;
  const target = resolveBase(first.value, info, ctx, declared);
  if (target?.kind !== 'symbol') return undefined;
  const kind = types.get(target.id);
  return kind === 'function' || kind === 'method' ? target.id : undefined;
}

/** The partial target of a name, from the scope its binding lives in. */
export function localPartialOf(
  e: Extract<Expr, { kind: 'name' }>,
  info: FileInfo,
  index: TypeIndex,
): string | undefined {
  const resolution = info.uses.get(spanKey(e.span))?.resolution;
  if (resolution?.kind !== 'scope') return undefined;
  const scope = info.scopes.scopes.find((s) => s.id === resolution.scope);
  if (scope === undefined) return undefined;
  return index.partials.get(scopeKey(info.filePath, scope))?.get(e.id);
}

function namesIn(target: Expr): string[] {
  switch (target.kind) {
    case 'name':
      return [target.id];
    case 'tuple':
    case 'list':
      return target.elements.flatMap(namesIn);
    case 'starred':
      return namesIn(target.value);
    default:
      return [];
  }
}

/** Assignment expressions anywhere in an expression, not counting lambda bodies. */
function walrusNames(e: Expr): string[] {
  if (e.kind === 'lambda') return [];
  const own = e.kind === 'namedexpr' && e.target.kind === 'name' ? [e.target.id] : [];
  return [...own, ...exprChildren(e).flatMap(walrusNames)];
}

function topLevelNames(st: Stmt): string[] {
  return st.kind === 'import'
    ? st.names.map((a) => a.asname ?? topLevel(a.name))
    : st.kind === 'importfrom' && st.names !== 'star'
      ? st.names.map((a) => a.asname ?? a.name)
      : [];
}

/**
 * Library executors (Phase 12.4). Their `__enter__` returns the executor itself, so `with
 * ThreadPoolExecutor() as pool:` gives `pool` the executor's type.
 */
export const EXECUTOR_TYPES: ReadonlySet<string> = new Set([
  'concurrent.futures.ThreadPoolExecutor',
  'concurrent.futures.ProcessPoolExecutor',
  'concurrent.futures.Executor',
]);

/** The bindings a statement makes in its own scope, each with the type it gives the name. */
function sourcesOf(
  st: Stmt,
  typeOf: (e: Expr) => LocalType | undefined,
  annotated: (e: Expr) => LocalType | undefined,
  calleeOf: (e: Expr) => string | undefined,
): Source[] {
  const out: Source[] = [];
  const untyped = (names: readonly string[]): void => {
    for (const name of names) out.push({ name, type: undefined });
  };
  switch (st.kind) {
    case 'assign': {
      const only = st.targets[0];
      if (st.targets.length === 1 && only?.kind === 'name') {
        out.push({ name: only.id, type: typeOf(st.value), callee: calleeOf(st.value) });
      } else {
        for (const t of st.targets) untyped(namesIn(t));
      }
      break;
    }
    case 'augassign':
      untyped(namesIn(st.target));
      break;
    case 'annassign':
      if (st.target.kind === 'name') {
        out.push({ name: st.target.id, type: annotated(st.annotation) });
      }
      break;
    case 'for':
      untyped(namesIn(st.target));
      break;
    case 'with':
      for (const item of st.items) {
        const target = item.target;
        const contextType = typeOf(item.context);
        const isExecutor =
          contextType?.name.kind === 'external' && EXECUTOR_TYPES.has(contextType.name.name);
        if (target?.kind === 'name' && isExecutor) {
          out.push({ name: target.id, type: contextType });
        } else if (target !== null) {
          untyped(namesIn(target));
        }
      }
      break;
    case 'try':
      for (const h of st.handlers) if (h.name !== null) untyped([h.name]);
      break;
    case 'import':
    case 'importfrom':
      untyped(topLevelNames(st));
      break;
    case 'funcdef':
    case 'classdef':
    case 'typealias':
      untyped([st.name]);
      break;
    case 'delete':
      for (const t of st.targets) untyped(namesIn(t));
      break;
    default:
      break;
  }
  for (const e of stmtOwnExprs(st)) untyped(walrusNames(e));
  return out;
}

/** The type of a name whose every binding gives the same type; undefined otherwise. */
function fold(types: readonly (LocalType | undefined)[]): LocalType | undefined {
  let acc = types[0];
  if (acc === undefined) return undefined;
  for (const next of types.slice(1)) {
    if (next === undefined || !sameTypeName(acc.name, next.name)) return undefined;
    const weaker: Confidence =
      CONFIDENCE_RANK[next.confidence] > CONFIDENCE_RANK[acc.confidence]
        ? next.confidence
        : acc.confidence;
    acc = { ...acc, confidence: weaker };
  }
  return acc;
}

/** The partial target of a name whose every binding is a partial of the same function. */
function foldCallees(callees: readonly (string | undefined)[]): string | undefined {
  const first = callees[0];
  if (first === undefined) return undefined;
  return callees.every((c) => c === first) ? first : undefined;
}

/**
 * Builds the type index for a set of files. Callables are read first, so a return type is known
 * before any call that uses it is typed. Then each scope's bindings are typed.
 */
export function buildTypeIndex(
  infos: readonly FileInfo[],
  ctx: InheritanceContext,
  declared: ReadonlySet<string>,
  types: ReadonlyMap<string, SymbolType>,
): TypeIndex {
  const callables = new Map<string, CallableSymbol>();
  const sources = new Map<string, Source[]>();
  const scopes = new Map<string, Scope>();

  const annotated =
    (info: FileInfo) =>
    (e: Expr): LocalType | undefined =>
      annotationType(typeExprOf(e, info, ctx, declared));

  const scopeOfSpan = (
    info: FileInfo,
    span: { readonly line: number; readonly column: number },
    kind: 'function' | 'class',
  ): Scope | undefined =>
    info.scopes.scopes.find(
      (s) =>
        s.kind === kind &&
        s.span !== null &&
        s.span.line === span.line &&
        s.span.column === span.column,
    );

  // Pass A: every callable and its declared return type.
  const readCallables = (
    info: FileInfo,
    stmts: readonly Stmt[],
    chain: readonly OwnerScope[],
  ): void => {
    for (const st of stmts) {
      if (st.kind === 'funcdef') {
        const inClass = chain[chain.length - 1]?.kind === 'class';
        const scope: OwnerScope = { kind: inClass ? 'method' : 'function', name: st.name };
        const id = ownerIdOf(info.filePath, [...chain, scope]);
        const ret = st.returns === null ? undefined : typeExprOf(st.returns, info, ctx, declared);
        const ownerTypeId = inClass ? ownerIdOf(info.filePath, chain) : undefined;
        callables.set(id, {
          id,
          symbolType: types.get(id) ?? (inClass ? 'method' : 'function'),
          ...(ret === undefined ? {} : { returnType: ret }),
          ...(ownerTypeId === undefined ? {} : { ownerTypeId }),
        });
        readCallables(info, st.body, [...chain, scope]);
      } else if (st.kind === 'classdef') {
        readCallables(info, st.body, [...chain, { kind: 'class', name: st.name }]);
      }
      for (const block of stmtBlocks(st)) readCallables(info, block, chain);
    }
  };

  // Pass B: the bindings of each scope.
  const readSources = (info: FileInfo, stmts: readonly Stmt[], key: string): void => {
    const push = (k: string, list: readonly Source[]): void => {
      const existing = sources.get(k) ?? [];
      sources.set(k, [...existing, ...list]);
    };
    for (const st of stmts) {
      const typeOf = (e: Expr): LocalType | undefined =>
        typeOfValue(e, info, ctx, declared, types, callables);
      const calleeOf = (e: Expr): string | undefined =>
        partialTargetOf(e, info, ctx, declared, types);
      push(key, sourcesOf(st, typeOf, annotated(info), calleeOf));
      if (st.kind === 'funcdef') {
        const scope = scopeOfSpan(info, st.span, 'function');
        if (scope !== undefined) {
          const k = scopeKey(info.filePath, scope);
          scopes.set(k, scope);
          const params: Source[] = [];
          for (const p of st.params) {
            if (p.name === null) continue;
            const type =
              p.kind === 'normal' && p.annotation !== null
                ? annotated(info)(p.annotation)
                : undefined;
            params.push({ name: p.name, type });
          }
          push(k, params);
          readSources(info, st.body, k);
        }
      } else if (st.kind === 'classdef') {
        const scope = scopeOfSpan(info, st.span, 'class');
        if (scope !== undefined) {
          const k = scopeKey(info.filePath, scope);
          scopes.set(k, scope);
          readSources(info, st.body, k);
        }
      }
      for (const block of stmtBlocks(st)) readSources(info, block, key);
    }
  };

  for (const info of infos) readCallables(info, info.body, []);
  for (const info of infos) {
    const moduleScope = info.scopes.scopes[0];
    if (moduleScope === undefined) continue;
    const key = scopeKey(info.filePath, moduleScope);
    scopes.set(key, moduleScope);
    readSources(info, info.body, key);
  }

  // A name is typed (or a partial) when every binding site of it in its scope was read, and they agree.
  const locals = new Map<string, ReadonlyMap<string, LocalType>>();
  const partials = new Map<string, ReadonlyMap<string, string>>();
  for (const [key, list] of sources) {
    const scope = scopes.get(key);
    if (scope === undefined) continue;
    const byName = new Map<string, Source[]>();
    for (const src of list) {
      const bucket = byName.get(src.name) ?? [];
      bucket.push(src);
      byName.set(src.name, bucket);
    }
    const typed = new Map<string, LocalType>();
    const bound = new Map<string, string>();
    for (const [name, bucket] of byName) {
      if ((scope.bindings.get(name) ?? []).length !== bucket.length) continue;
      const t = fold(bucket.map((src) => src.type));
      if (t !== undefined) typed.set(name, t);
      const callee = foldCallees(bucket.map((src) => src.callee));
      if (callee !== undefined) bound.set(name, callee);
    }
    locals.set(key, typed);
    partials.set(key, bound);
  }
  return { callables, locals, partials };
}
