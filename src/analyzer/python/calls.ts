/**
 * Python calls (V3 Phase 5.4a).
 *
 * Emits one call fact for each call whose callee resolves to a repository symbol through the
 * bindings of its module. The owner is the function or method that contains the call, or null for
 * module-level code.
 *
 * Resolved here:
 * - A name bound at module level, including a `from x import f` name (`calls`).
 * - `module.f()` when `module` is a repository module bound by `import`.
 * - `Class.method()` for a repository class, and `Outer.Inner()` for a nested one.
 * - `Class(...)`, which is a `construct` to the class, plus a `call` to `Class.__init__` when the
 *   class defines one.
 *
 * Not resolved yet, and emitting no edge: calls through a local name (a parameter, a local
 * variable, a nested function), `self.m()` and `super().m()` (5.4b), receivers with a known type
 * (5.4c), `functools.partial` and `__call__` (5.4d), and anything external.
 */
import { ownerIdOf, type OwnerScope } from '../../facts/owner-rule.js';
import type { FactTarget } from '../../facts/types.js';
import type { Confidence, SourceSpan, SymbolType } from '../../types.js';
import type { Expr, Stmt } from './ast.js';
import { exprChildren, stmtBlocks, stmtOwnExprs } from './ast-walk.js';
import {
  buildFileInfo,
  resolveBase,
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

/** Calls the statements make, with the scopes that enclose each call (outermost first). */
function visitStmts(
  stmts: readonly Stmt[],
  chain: readonly OwnerScope[],
  onCall: (call: CallExpr, chain: readonly OwnerScope[]) => void,
): void {
  for (const st of stmts) {
    for (const e of stmtOwnExprs(st)) visitExpr(e, chain, onCall);
    if (st.kind === 'funcdef') {
      const inClass = chain[chain.length - 1]?.kind === 'class';
      const scope: OwnerScope = { kind: inClass ? 'method' : 'function', name: st.name };
      visitStmts(st.body, [...chain, scope], onCall);
    } else if (st.kind === 'classdef') {
      visitStmts(st.body, [...chain, { kind: 'class', name: st.name }], onCall);
    }
    for (const block of stmtBlocks(st)) visitStmts(block, chain, onCall);
  }
}

function visitExpr(
  e: Expr,
  chain: readonly OwnerScope[],
  onCall: (call: CallExpr, chain: readonly OwnerScope[]) => void,
): void {
  if (e.kind === 'call') onCall(e, chain);
  for (const child of exprChildren(e)) visitExpr(child, chain, onCall);
}

function calleesOf(
  call: CallExpr,
  info: FileInfo,
  ctx: InheritanceContext,
  declared: ReadonlySet<string>,
  types: ReadonlyMap<string, SymbolType>,
): { readonly callee: FactTarget; readonly role: 'call' | 'construct' }[] {
  const target = resolveBase(call.func, info, ctx, declared);
  if (target?.kind !== 'symbol') return [];
  const kind = types.get(target.id);
  if (kind === 'class') {
    const out: { callee: FactTarget; role: 'call' | 'construct' }[] = [
      { callee: target, role: 'construct' },
    ];
    const init = `${target.id}.__init__`;
    if (declared.has(init)) out.push({ callee: { kind: 'symbol', id: init }, role: 'call' });
    return out;
  }
  if (kind === 'function' || kind === 'method') return [{ callee: target, role: 'call' }];
  return [];
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

  const calls: PythonCall[] = [];
  for (const info of infos) {
    visitStmts(info.body, [], (call, chain) => {
      const owner = chain.length === 0 ? null : ownerIdOf(info.filePath, chain);
      for (const c of calleesOf(call, info, ctx, declared, types)) {
        calls.push({
          filePath: info.filePath,
          owner,
          span: toSourceSpan(call.span, info.filePath),
          callee: c.callee,
          role: c.role,
          confidence: 'high',
        });
      }
    });
  }
  return { calls };
}
