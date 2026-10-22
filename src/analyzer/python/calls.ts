/**
 * Python calls (V3 Phase 5.4a, 5.4b and 5.4c).
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
 * Not resolved yet, and emitting no edge: the two-argument `super(C, self)` form, `functools.partial`
 * and `__call__` (5.4d), and anything external.
 */
import { ownerIdOf, type OwnerScope } from '../../facts/owner-rule.js';
import type { FactTarget } from '../../facts/types.js';
import type { Confidence, SourceSpan, SymbolType } from '../../types.js';
import type { Expr, Stmt } from './ast.js';
import { exprChildren, stmtBlocks, stmtOwnExprs } from './ast-walk.js';
import { formatExpr } from './expression-format.js';
import { buildTypeIndex, localTypeOf, typeOfValue, type TypeIndex } from './typed-receivers.js';
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

export interface PythonCall {
  readonly filePath: string;
  /** The id of the enclosing function or method, or null for module-level code. */
  readonly owner: string | null;
  readonly span: SourceSpan;
  readonly callee: FactTarget;
  readonly role: 'call' | 'construct';
  readonly confidence: Confidence;
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

function visitStmts(stmts: readonly Stmt[], frame: Frame, filePath: string, onCall: OnCall): void {
  for (const st of stmts) {
    for (const e of stmtOwnExprs(st)) visitExpr(e, frame, onCall);
    if (st.kind === 'funcdef') {
      const inClass = frame.chain[frame.chain.length - 1]?.kind === 'class';
      const scope: OwnerScope = { kind: inClass ? 'method' : 'function', name: st.name };
      const chain = [...frame.chain, scope];
      let method = frame.method;
      if (inClass) {
        const isStatic = st.decorators.some((d) => formatExpr(d) === 'staticmethod');
        const first = st.params[0];
        const receiver =
          !isStatic && first?.kind === 'normal' && first.name !== null ? first.name : undefined;
        method = {
          label: chain.map((s) => s.name).join('.'),
          classId: ownerIdOf(filePath, frame.chain),
          receiver,
        };
      }
      visitStmts(st.body, { chain, method }, filePath, onCall);
    } else if (st.kind === 'classdef') {
      visitStmts(
        st.body,
        { chain: [...frame.chain, { kind: 'class', name: st.name }], method: undefined },
        filePath,
        onCall,
      );
    }
    for (const block of stmtBlocks(st)) visitStmts(block, frame, filePath, onCall);
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
  call: CallExpr,
  frame: Frame,
  info: FileInfo,
  mro: ReadonlyMap<string, readonly string[] | null>,
  types: ReadonlyMap<string, SymbolType>,
): FactTarget | undefined {
  const method = frame.method;
  const func = call.func;
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
  call: CallExpr,
  info: FileInfo,
  ctx: InheritanceContext,
  declared: ReadonlySet<string>,
  types: ReadonlyMap<string, SymbolType>,
  mro: ReadonlyMap<string, readonly string[] | null>,
  index: TypeIndex,
): { readonly callee: FactTarget; readonly confidence: Confidence } | undefined {
  const func = call.func;
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

function calleesOf(
  call: CallExpr,
  frame: Frame,
  info: FileInfo,
  ctx: InheritanceContext,
  declared: ReadonlySet<string>,
  types: ReadonlyMap<string, SymbolType>,
  mro: ReadonlyMap<string, readonly string[] | null>,
  index: TypeIndex,
): CalleeRef[] {
  const target = resolveBase(call.func, info, ctx, declared);
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
    return [];
  }
  const viaSelf = receiverCallee(call, frame, info, mro, types);
  if (viaSelf !== undefined) return [{ callee: viaSelf, role: 'call', confidence: 'high' }];
  const typed = typedReceiverCallee(call, info, ctx, declared, types, mro, index);
  return typed === undefined
    ? []
    : [{ callee: typed.callee, role: 'call', confidence: typed.confidence }];
}

/** Analyzes the calls in a set of Python files. Never throws on malformed input. */
export function analyzePythonCalls(
  files: readonly InheritanceFile[],
  ctx: InheritanceContext,
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

  const calls: PythonCall[] = [];
  for (const info of infos) {
    visitStmts(info.body, { chain: [], method: undefined }, info.filePath, (call, frame) => {
      const owner = frame.chain.length === 0 ? null : ownerIdOf(info.filePath, frame.chain);
      for (const c of calleesOf(call, frame, info, ctx, declared, types, mro, index)) {
        calls.push({
          filePath: info.filePath,
          owner,
          span: toSourceSpan(call.span, info.filePath),
          callee: c.callee,
          role: c.role,
          confidence: c.confidence,
        });
      }
    });
  }
  return { calls };
}
