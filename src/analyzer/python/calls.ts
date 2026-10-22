/**
 * Python calls (V3 Phase 5.4a through 5.5).
 *
 * Emits one call fact for each call whose callee resolves to a repository symbol through the
 * bindings of its module. The owner is the function or method that contains the call, or null for
 * module-level code.
 *
 * Resolved:
 * - A name bound at module level, including a `from x import f` name (`calls`).
 * - `module.f()` when `module` is a repository module bound by `import`.
 * - `Class.method()` for a repository class, and `Outer.Inner()` for a nested one.
 * - `Class(...)`, which is a `construct` to the class, plus a `call` to `Class.__init__` when the
 *   class defines one.
 * - `self.m()` and `cls.m()` inside a method, where the receiver is the method's own first
 *   parameter and the method is not a `@staticmethod`. The target is the first method named `m`
 *   in the class's MRO (5.3).
 * - `super().m()` (zero-argument form) inside a method. The target is the first method named `m`
 *   after the enclosing class in its MRO.
 *
 * - A receiver with a type from the local-type rules (5.4c): an annotated parameter or variable,
 *   a name bound only to one class's constructor, a call returning a class or `Self` (medium), or
 *   a constructor used directly. The method is looked up through the class's MRO.
 *
 * - `functools.partial(f)(...)`, a name bound only to `functools.partial(f)`, and `f.__call__()`
 *   for a repository function `f` (5.4d).
 *
 * Decorators (5.5): applying a repository decorator emits a `call` from the decorated symbol's
 * owner to the decorator, with `mechanism: 'decorator'`. A decorator that returns its argument
 * unchanged (`IDENTITY_DECORATORS`, or a name in `CallOptions.identityDecorators`) keeps calls to
 * the decorated symbol at their usual confidence. Any other decorator drops those calls to medium.
 *
 * Not resolved yet, and emitting no edge: the two-argument `super(C, self)` form, and anything
 * external.
 */
import { ownerIdOf, type OwnerScope } from '../../facts/owner-rule.js';
import type { FactTarget } from '../../facts/types.js';
import type { Confidence, SourceSpan, SymbolType } from '../../types.js';
import type { Expr, Stmt } from './ast.js';
import { exprChildren, stmtBlocks, stmtOwnExprs } from './ast-walk.js';
import { dottedName } from './expression-format.js';
import {
  buildTypeIndex,
  localPartialOf,
  localTypeOf,
  partialTargetOf,
  typeOfValue,
  type TypeIndex,
} from './typed-receivers.js';
import {
  analyzeInheritance,
  buildFileInfo,
  resolveBase,
  spanKey,
  toSourceSpan,
  type FileInfo,
  type InheritanceContext,
  type InheritanceFile,
} from './inheritance.js';

type CallExpr = Extract<Expr, { kind: 'call' }>;
type NameExpr = Extract<Expr, { kind: 'name' }>;

/** Decorators that return their argument unchanged, by the qualified name they resolve to. */
const IDENTITY_DECORATORS: ReadonlySet<string> = new Set([
  'property',
  'staticmethod',
  'classmethod',
  'functools.wraps',
  'functools.cache',
  'functools.lru_cache',
  'dataclasses.dataclass',
  'contextlib.contextmanager',
]);

export interface CallOptions {
  /** Repository decorators that return their argument unchanged, as written (`python.identityDecorators`). */
  readonly identityDecorators?: readonly string[];
}

export interface PythonCall {
  readonly filePath: string;
  /** The id of the enclosing function or method, or null for module-level code. */
  readonly owner: string | null;
  readonly span: SourceSpan;
  readonly callee: FactTarget;
  readonly role: 'call' | 'construct';
  readonly confidence: Confidence;
  /** `decorator` for the call that applies a decorator (5.5). */
  readonly mechanism?: 'decorator';
}

export interface CallAnalysis {
  readonly calls: readonly PythonCall[];
}

/** The method a statement is inside, when that method's receiver is known. */
interface MethodFrame {
  /** The dotted names of the enclosing scopes, such as `C.m`, matching the scope label. */
  readonly label: string;
  readonly classId: string;
  /** The receiver's name: the first parameter, or undefined for a `@staticmethod`. */
  readonly receiver: string | undefined;
}

interface Frame {
  readonly chain: readonly OwnerScope[];
  readonly method: MethodFrame | undefined;
}

type OnCall = (call: CallExpr, frame: Frame) => void;
type OnDecorator = (decorator: Expr, decoratedId: string, frame: Frame) => void;

interface Visitor {
  readonly onCall: OnCall;
  readonly onDecorator: OnDecorator;
}

/** The scope chain of a `def` or `class` statement, including the statement itself. */
function definedChain(st: Stmt, frame: Frame): readonly OwnerScope[] | undefined {
  if (st.kind === 'classdef') return [...frame.chain, { kind: 'class', name: st.name }];
  if (st.kind !== 'funcdef') return undefined;
  const inClass = frame.chain[frame.chain.length - 1]?.kind === 'class';
  return [...frame.chain, { kind: inClass ? 'method' : 'function', name: st.name }];
}

function visitStmts(stmts: readonly Stmt[], frame: Frame, filePath: string, v: Visitor): void {
  for (const st of stmts) {
    const chain = definedChain(st, frame);
    // Decorators run in the enclosing scope, before the statement's own expressions. They are
    // visited here, so `stmtOwnExprs` below skips them.
    const decorators: readonly Expr[] =
      st.kind === 'funcdef' || st.kind === 'classdef' ? st.decorators : [];
    if (chain !== undefined) visitDecorators(decorators, ownerIdOf(filePath, chain), frame, v);
    for (const e of stmtOwnExprs(st)) {
      if (!decorators.includes(e)) visitExpr(e, frame, v.onCall);
    }
    if (chain !== undefined && st.kind === 'funcdef') {
      const inClass = frame.chain[frame.chain.length - 1]?.kind === 'class';
      let method = frame.method;
      if (inClass) {
        const isStatic = st.decorators.some((d) => dottedName(d) === 'staticmethod');
        const first = st.params[0];
        const receiver =
          !isStatic && first?.kind === 'normal' && first.name !== null ? first.name : undefined;
        method = {
          label: chain.map((s) => s.name).join('.'),
          classId: ownerIdOf(filePath, frame.chain),
          receiver,
        };
      }
      visitStmts(st.body, { chain, method }, filePath, v);
    } else if (chain !== undefined && st.kind === 'classdef') {
      visitStmts(st.body, { chain, method: undefined }, filePath, v);
    }
    for (const block of stmtBlocks(st)) visitStmts(block, frame, filePath, v);
  }
}

function visitDecorators(
  decorators: readonly Expr[],
  decoratedId: string,
  frame: Frame,
  v: Visitor,
): void {
  for (const d of decorators) {
    v.onDecorator(d, decoratedId, frame);
    // The decorator's own call is reported by `onDecorator`; only its arguments are visited here.
    for (const child of exprChildren(d)) visitExpr(child, frame, v.onCall);
  }
}

function visitExpr(e: Expr, frame: Frame, onCall: OnCall): void {
  if (e.kind === 'call') onCall(e, frame);
  for (const child of exprChildren(e)) visitExpr(child, frame, onCall);
}

/** The first method named `attr` among `ids`, which are classes in MRO order. */
function firstMethod(
  ids: readonly string[],
  attr: string,
  types: ReadonlyMap<string, SymbolType>,
): FactTarget | undefined {
  for (const id of ids) {
    const candidate = `${id}.${attr}`;
    if (types.get(candidate) === 'method') return { kind: 'symbol', id: candidate };
  }
  return undefined;
}

/** `self.m()`, `cls.m()` and zero-argument `super().m()` inside a method. */
function receiverCallee(
  func: Expr,
  frame: Frame,
  info: FileInfo,
  mro: ReadonlyMap<string, readonly string[] | null>,
  types: ReadonlyMap<string, SymbolType>,
): FactTarget | undefined {
  const method = frame.method;
  if (method === undefined || func.kind !== 'attribute') return undefined;

  if (func.value.kind === 'call' && func.value.args.length === 0) {
    const superName = func.value.func;
    if (superName.kind !== 'name' || superName.id !== 'super') return undefined;
    if (info.uses.get(spanKey(superName.span))?.resolution.kind !== 'builtin') return undefined;
    const order = mro.get(method.classId);
    return order === undefined || order === null
      ? undefined
      : firstMethod(order.slice(1), func.attr, types);
  }

  if (func.value.kind !== 'name' || method.receiver === undefined) return undefined;
  if (func.value.id !== method.receiver) return undefined;
  const resolution = info.uses.get(spanKey(func.value.span))?.resolution;
  if (resolution?.kind !== 'scope' || resolution.scopeKind !== 'function') return undefined;
  const label = info.scopes.scopes.find((s) => s.id === resolution.scope)?.label;
  if (label !== method.label) return undefined;
  const order = mro.get(method.classId);
  return order === undefined || order === null ? undefined : firstMethod(order, func.attr, types);
}

/** A resolved callee, its role and its confidence. */
interface CalleeRef {
  readonly callee: FactTarget;
  readonly role: 'call' | 'construct';
  readonly confidence: Confidence;
}

/** A receiver typed by the rules: `x.m()` for a typed name, or `C().m()` for a constructor. */
function typedReceiverCallee(
  func: Expr,
  info: FileInfo,
  ctx: InheritanceContext,
  declared: ReadonlySet<string>,
  types: ReadonlyMap<string, SymbolType>,
  mro: ReadonlyMap<string, readonly string[] | null>,
  index: TypeIndex,
): { readonly callee: FactTarget; readonly confidence: Confidence } | undefined {
  if (func.kind !== 'attribute') return undefined;
  const type =
    func.value.kind === 'name'
      ? localTypeOf(func.value, info, index)
      : typeOfValue(func.value, info, ctx, declared, types, index.callables);
  if (type === undefined) return undefined;
  const name = type.name;
  if (name.kind !== 'symbol' || types.get(name.id) !== 'class') return undefined;
  const order = mro.get(name.id);
  if (order === undefined || order === null) return undefined;
  const callee = firstMethod(order, func.attr, types);
  return callee === undefined ? undefined : { callee, confidence: type.confidence };
}

/** The callees of a call, given the expression that is called. */
function calleesOf(
  func: Expr,
  frame: Frame,
  info: FileInfo,
  ctx: InheritanceContext,
  declared: ReadonlySet<string>,
  types: ReadonlyMap<string, SymbolType>,
  mro: ReadonlyMap<string, readonly string[] | null>,
  index: TypeIndex,
): CalleeRef[] {
  const target = resolveBase(func, info, ctx, declared);
  if (target?.kind === 'symbol') {
    const kind = types.get(target.id);
    if (kind === 'class') {
      const out: CalleeRef[] = [{ callee: target, role: 'construct', confidence: 'high' }];
      const init = `${target.id}.__init__`;
      if (declared.has(init)) {
        out.push({ callee: { kind: 'symbol', id: init }, role: 'call', confidence: 'high' });
      }
      return out;
    }
    if (kind === 'function' || kind === 'method') {
      return [{ callee: target, role: 'call', confidence: 'high' }];
    }
    // A variable or constant can still be a partial, so fall through to the call forms below.
  }
  const viaSelf = receiverCallee(func, frame, info, mro, types);
  if (viaSelf !== undefined) return [{ callee: viaSelf, role: 'call', confidence: 'high' }];
  const typed = typedReceiverCallee(func, info, ctx, declared, types, mro, index);
  if (typed !== undefined)
    return [{ callee: typed.callee, role: 'call', confidence: typed.confidence }];
  const viaPartial = partialCallee(func, info, ctx, declared, types, index);
  return viaPartial === undefined ? [] : [{ callee: viaPartial, role: 'call', confidence: 'high' }];
}

/**
 * `functools.partial(f)(...)`, a name bound only to `functools.partial(f)`, and `f.__call__(...)`
 * for a repository function `f`.
 */
function partialCallee(
  func: Expr,
  info: FileInfo,
  ctx: InheritanceContext,
  declared: ReadonlySet<string>,
  types: ReadonlyMap<string, SymbolType>,
  index: TypeIndex,
): FactTarget | undefined {
  if (func.kind === 'call') {
    const id = partialTargetOf(func, info, ctx, declared, types);
    return id === undefined ? undefined : { kind: 'symbol', id };
  }
  if (func.kind === 'name') {
    const id = localPartialOf(func, info, index);
    return id === undefined ? undefined : { kind: 'symbol', id };
  }
  if (func.kind === 'attribute' && func.attr === '__call__') {
    const target = resolveBase(func.value, info, ctx, declared);
    const kind = target?.kind === 'symbol' ? types.get(target.id) : undefined;
    if (target?.kind === 'symbol' && (kind === 'function' || kind === 'method')) return target;
  }
  return undefined;
}

/** The name at the root of a name or attribute chain, such as `functools` in `functools.cache`. */
function rootName(e: Expr): NameExpr | undefined {
  let cur: Expr = e;
  while (cur.kind === 'attribute') cur = cur.value;
  return cur.kind === 'name' ? cur : undefined;
}

/**
 * Whether a decorator returns its argument unchanged. A stdlib decorator is matched by the
 * qualified name it resolves to, so `from functools import cache` and `@functools.cache` both count.
 * A configured name matches as it is written.
 */
function isIdentityDecorator(d: Expr, info: FileInfo, configured: ReadonlySet<string>): boolean {
  const head = d.kind === 'call' ? d.func : d;
  const written = dottedName(head);
  if (written === undefined) return false;
  if (configured.has(written)) return true;
  const root = rootName(head);
  if (root === undefined) return false;
  if (info.uses.get(spanKey(root.span))?.resolution.kind === 'builtin') {
    return IDENTITY_DECORATORS.has(written);
  }
  const imp = info.imported.get(root.id);
  if (imp === undefined) return false;
  const base = imp.name === null ? imp.module : `${imp.module}.${imp.name}`;
  const rest = written.split('.').slice(1);
  return IDENTITY_DECORATORS.has([base, ...rest].join('.'));
}

/** Analyzes the calls in a set of Python files. Never throws on malformed input. */
export function analyzePythonCalls(
  files: readonly InheritanceFile[],
  ctx: InheritanceContext,
  options: CallOptions = {},
): CallAnalysis {
  const infos = files.map((f) => buildFileInfo(f, ctx));
  const declared = new Set<string>();
  const types = new Map<string, SymbolType>();
  for (const info of infos) {
    for (const d of info.declarations) {
      declared.add(d.id);
      types.set(d.id, d.symbolType);
    }
  }

  // The MRO of each class, from the inheritance analysis (5.3). Conditional twins keep the first.
  const mro = new Map<string, readonly string[] | null>();
  for (const c of analyzeInheritance(files, ctx).classes) {
    if (!mro.has(c.id)) mro.set(c.id, c.mro);
  }
  const index = buildTypeIndex(infos, ctx, declared, types);
  const configured: ReadonlySet<string> = new Set(options.identityDecorators ?? []);
  // Decorated symbols with at least one decorator that is not an identity decorator.
  const nonIdentity = new Set<string>();

  const calls: PythonCall[] = [];
  for (const info of infos) {
    const ownerOf = (frame: Frame): string | null =>
      frame.chain.length === 0 ? null : ownerIdOf(info.filePath, frame.chain);
    const visitor: Visitor = {
      onCall: (call, frame) => {
        const owner = ownerOf(frame);
        for (const c of calleesOf(call.func, frame, info, ctx, declared, types, mro, index)) {
          calls.push({
            filePath: info.filePath,
            owner,
            span: toSourceSpan(call.span, info.filePath),
            callee: c.callee,
            role: c.role,
            confidence: c.confidence,
          });
        }
      },
      onDecorator: (decorator, decoratedId, frame) => {
        if (!isIdentityDecorator(decorator, info, configured)) nonIdentity.add(decoratedId);
        const owner = ownerOf(frame);
        const target = decorator.kind === 'call' ? decorator.func : decorator;
        for (const c of calleesOf(target, frame, info, ctx, declared, types, mro, index)) {
          calls.push({
            filePath: info.filePath,
            owner,
            span: toSourceSpan(decorator.span, info.filePath),
            callee: c.callee,
            role: c.role,
            confidence: c.confidence,
            mechanism: 'decorator',
          });
        }
      },
    };
    visitStmts(info.body, { chain: [], method: undefined }, info.filePath, visitor);
  }

  // A call to a decorated symbol with a non-identity decorator is at most medium confidence (5.5).
  const out = calls.map((c): PythonCall =>
    c.callee.kind === 'symbol' && c.confidence === 'high' && nonIdentity.has(c.callee.id)
      ? { ...c, confidence: 'medium' }
      : c,
  );
  return { calls: out };
}
