/**
 * Python scopes and name bindings (V3 Phase 5.1).
 *
 * Builds the scope tree of one module and resolves every name use to the binding that Python's
 * LEGB rules select. It reads the statement AST only: it evaluates nothing and follows no
 * imports. A name that a `from x import *` may supply is reported as unresolved, not guessed.
 *
 * Rules modeled here:
 * - A module, class, function, lambda, comprehension or PEP 695 type-parameter list is a scope.
 * - A name bound anywhere in a function body is local to it, unless the body declares it `global`
 *   or `nonlocal`. All bindings are collected before any use is resolved, so a forward reference
 *   resolves the same way as a backward one.
 * - Only code that runs directly in a class body sees the class's names. Methods, nested functions
 *   and comprehensions skip the class scope.
 * - A conditional or repeated definition adds one binding per definition site (the union).
 * - `del x` declares `x` local and records a `delete` binding. Lookups are not flow-sensitive, so
 *   the name stays bound after `del` in this model.
 * - Default values, decorators, base classes and the first iterable of a comprehension run in the
 *   enclosing scope. Annotations run in the type-parameter scope when the definition has one.
 * - A walrus target inside a comprehension binds in the nearest enclosing non-comprehension scope.
 */
import type { Expr, FStringPart, Param, Pattern, Span, Stmt, TypeParam } from './ast.js';

export type ScopeKind =
  'module' | 'class' | 'function' | 'lambda' | 'comprehension' | 'type-params';

export type BindingKind =
  | 'assign'
  | 'augassign'
  | 'annotation'
  | 'def'
  | 'class'
  | 'import'
  | 'param'
  | 'for'
  | 'with'
  | 'except'
  | 'match'
  | 'walrus'
  | 'type-alias'
  | 'type-param'
  | 'delete';

export interface Binding {
  readonly name: string;
  readonly kind: BindingKind;
  /** The scope the name is bound in, which can differ from the scope of the statement (`global`). */
  readonly scope: number;
  readonly span: Span;
}

export interface Scope {
  /** Index into `ScopeAnalysis.scopes`. The module is always 0. */
  readonly id: number;
  readonly kind: ScopeKind;
  /** Readable name such as `Outer.method`, `<lambda>` or `<module>`. Not unique. */
  readonly label: string;
  readonly parent: number | null;
  readonly span: Span | null;
  /** Names this scope declares `global`. */
  readonly globals: Set<string>;
  /** Names this scope declares `nonlocal`. */
  readonly nonlocals: Set<string>;
  readonly bindings: Map<string, Binding[]>;
  /** True when this scope contains `from x import *`. Only the module's flag is consulted. */
  hasStarImport: boolean;
}

export type Resolution =
  | { readonly kind: 'scope'; readonly scope: number; readonly scopeKind: ScopeKind }
  | { readonly kind: 'builtin'; readonly name: string }
  | { readonly kind: 'implicit'; readonly name: string }
  | { readonly kind: 'unresolved'; readonly reason: 'star-import' | 'undefined' };

export interface NameUse {
  readonly name: string;
  readonly span: Span;
  /** The scope the use runs in. */
  readonly scope: number;
  readonly access: 'load' | 'delete';
  readonly resolution: Resolution;
}

export interface ScopeProblem {
  readonly span: Span;
  readonly message: string;
}

export interface ScopeAnalysis {
  readonly scopes: readonly Scope[];
  readonly uses: readonly NameUse[];
  readonly problems: readonly ScopeProblem[];
}

/** Names the interpreter defines in every module. */
const IMPLICIT_MODULE_NAMES: ReadonlySet<string> = new Set([
  '__annotations__',
  '__builtins__',
  '__cached__',
  '__doc__',
  '__file__',
  '__loader__',
  '__name__',
  '__package__',
  '__spec__',
]);

/** Built-in names of CPython 3.10 through 3.13, from the `builtins` module. */
const BUILTIN_NAMES: ReadonlySet<string> = new Set(
  (
    'ArithmeticError AssertionError AttributeError BaseException BaseExceptionGroup ' +
    'BlockingIOError BrokenPipeError BufferError BytesWarning ChildProcessError ' +
    'ConnectionAbortedError ConnectionError ConnectionRefusedError ConnectionResetError ' +
    'DeprecationWarning EOFError Ellipsis EncodingWarning EnvironmentError Exception ' +
    'ExceptionGroup False FileExistsError FileNotFoundError FloatingPointError FutureWarning ' +
    'GeneratorExit IOError ImportError ImportWarning IndentationError IndexError ' +
    'InterruptedError IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError ' +
    'ModuleNotFoundError NameError None NotADirectoryError NotImplemented NotImplementedError ' +
    'OSError OverflowError PendingDeprecationWarning PermissionError ProcessLookupError ' +
    'RecursionError ReferenceError ResourceWarning RuntimeError RuntimeWarning ' +
    'StopAsyncIteration StopIteration SyntaxError SyntaxWarning SystemError SystemExit ' +
    'TabError TimeoutError True TypeError UnboundLocalError UnicodeDecodeError ' +
    'UnicodeEncodeError UnicodeError UnicodeTranslateError UnicodeWarning UserWarning ' +
    'ValueError Warning ZeroDivisionError __build_class__ __debug__ __import__ abs aiter all ' +
    'anext any ascii bin bool breakpoint bytearray bytes callable chr classmethod compile ' +
    'complex copyright credits delattr dict dir divmod enumerate eval exec exit filter float ' +
    'format frozenset getattr globals hasattr hash help hex id input int isinstance issubclass ' +
    'iter len license list locals map max memoryview min next object oct open ord pow print ' +
    'property quit range repr reversed round set setattr slice sorted staticmethod str sum ' +
    'super tuple type vars zip'
  ).split(' '),
);

const MODULE = 0;

interface PendingBind {
  readonly name: string;
  readonly kind: BindingKind;
  readonly span: Span;
  readonly scope: number;
  readonly walrus: boolean;
}

interface PendingUse {
  readonly name: string;
  readonly span: Span;
  readonly scope: number;
  readonly access: 'load' | 'delete';
}

/** Collects scopes, bindings and name uses in one walk. Resolution happens afterwards. */
class Builder {
  readonly scopes: Scope[] = [];
  readonly binds: PendingBind[] = [];
  readonly uses: PendingUse[] = [];
  readonly nonlocalDecls: { readonly scope: number; readonly name: string; readonly span: Span }[] =
    [];
  readonly problems: ScopeProblem[] = [];

  scope(kind: ScopeKind, label: string, parent: number | null, span: Span | null): number {
    const id = this.scopes.length;
    this.scopes.push({
      id,
      kind,
      label,
      parent,
      span,
      globals: new Set(),
      nonlocals: new Set(),
      bindings: new Map(),
      hasStarImport: false,
    });
    return id;
  }

  at(id: number): Scope {
    return scopeAt(this.scopes, id);
  }

  bind(scope: number, name: string, kind: BindingKind, span: Span, walrus = false): void {
    this.binds.push({ name, kind, span, scope, walrus });
  }

  use(scope: number, name: string, span: Span, access: 'load' | 'delete' = 'load'): void {
    this.uses.push({ name, span, scope, access });
  }
}

function scopeAt(scopes: readonly Scope[], id: number): Scope {
  const found = scopes[id];
  if (found === undefined) throw new Error(`unknown Python scope ${id}`);
  return found;
}

function topLevelName(dotted: string): string {
  const dot = dotted.indexOf('.');
  return dot < 0 ? dotted : dotted.slice(0, dot);
}

class Walker {
  readonly b = new Builder();

  walkBody(body: readonly Stmt[], s: number): void {
    for (const st of body) this.stmt(st, s);
  }

  private stmt(st: Stmt, s: number): void {
    const b = this.b;
    switch (st.kind) {
      case 'expr':
        this.expr(st.value, s);
        return;
      case 'assign':
        this.expr(st.value, s);
        for (const t of st.targets) this.target(t, s, 'assign');
        return;
      case 'augassign':
        if (st.target.kind === 'name') {
          b.use(s, st.target.id, st.target.span);
          b.bind(s, st.target.id, 'augassign', st.target.span);
        } else {
          this.expr(st.target, s);
        }
        this.expr(st.value, s);
        return;
      case 'annassign':
        this.expr(st.annotation, s);
        if (st.value !== null) this.expr(st.value, s);
        this.target(st.target, s, 'annotation');
        return;
      case 'return':
        if (st.value !== null) this.expr(st.value, s);
        return;
      case 'delete':
        for (const t of st.targets) this.delete(t, s);
        return;
      case 'raise':
        if (st.exc !== null) this.expr(st.exc, s);
        if (st.cause !== null) this.expr(st.cause, s);
        return;
      case 'assert':
        this.expr(st.test, s);
        if (st.msg !== null) this.expr(st.msg, s);
        return;
      case 'pass':
      case 'break':
      case 'continue':
        return;
      case 'global':
        if (s !== MODULE) for (const name of st.names) b.at(s).globals.add(name);
        return;
      case 'nonlocal':
        if (s === MODULE) {
          b.problems.push({ span: st.span, message: 'nonlocal declaration at module level' });
        } else {
          for (const name of st.names) {
            b.at(s).nonlocals.add(name);
            b.nonlocalDecls.push({ scope: s, name, span: st.span });
          }
        }
        return;
      case 'import':
        for (const alias of st.names) {
          b.bind(s, alias.asname ?? topLevelName(alias.name), 'import', alias.span);
        }
        return;
      case 'importfrom':
        if (st.names === 'star') {
          b.at(s).hasStarImport = true;
        } else {
          for (const alias of st.names) {
            b.bind(s, alias.asname ?? alias.name, 'import', alias.span);
          }
        }
        return;
      case 'funcdef':
        this.funcdef(st, s);
        return;
      case 'classdef':
        this.classdef(st, s);
        return;
      case 'if':
      case 'while':
        this.expr(st.test, s);
        this.walkBody(st.body, s);
        this.walkBody(st.orelse, s);
        return;
      case 'for':
        this.expr(st.iter, s);
        this.target(st.target, s, 'for');
        this.walkBody(st.body, s);
        this.walkBody(st.orelse, s);
        return;
      case 'with':
        for (const item of st.items) {
          this.expr(item.context, s);
          if (item.target !== null) this.target(item.target, s, 'with');
        }
        this.walkBody(st.body, s);
        return;
      case 'try':
        this.walkBody(st.body, s);
        for (const handler of st.handlers) {
          if (handler.type !== null) this.expr(handler.type, s);
          if (handler.name !== null) b.bind(s, handler.name, 'except', handler.span);
          this.walkBody(handler.body, s);
        }
        this.walkBody(st.orelse, s);
        this.walkBody(st.finalbody, s);
        return;
      case 'match':
        this.expr(st.subject, s);
        for (const c of st.cases) {
          this.pattern(c.pattern, s);
          if (c.guard !== null) this.expr(c.guard, s);
          this.walkBody(c.body, s);
        }
        return;
      case 'typealias': {
        b.bind(s, st.name, 'type-alias', st.span);
        const inner = st.typeParams.length > 0 ? this.typeScope(st.typeParams, s, st.span) : s;
        this.expr(st.value, inner);
        return;
      }
    }
  }

  private funcdef(st: Extract<Stmt, { kind: 'funcdef' }>, s: number): void {
    for (const d of st.decorators) this.expr(d, s);
    const tp = st.typeParams.length > 0 ? this.typeScope(st.typeParams, s, st.span) : s;
    this.defaults(st.params, s);
    this.annotations(st.params, st.returns, tp);
    this.b.bind(s, st.name, 'def', st.span);
    const f = this.b.scope('function', this.label(s, st.name), tp, st.span);
    this.bindParams(st.params, f);
    this.walkBody(st.body, f);
  }

  private classdef(st: Extract<Stmt, { kind: 'classdef' }>, s: number): void {
    for (const d of st.decorators) this.expr(d, s);
    const tp = st.typeParams.length > 0 ? this.typeScope(st.typeParams, s, st.span) : s;
    for (const base of st.bases) this.expr(base.value, tp);
    this.b.bind(s, st.name, 'class', st.span);
    const c = this.b.scope('class', this.label(s, st.name), tp, st.span);
    this.walkBody(st.body, c);
  }

  private typeScope(params: readonly TypeParam[], parent: number, span: Span): number {
    const id = this.b.scope('type-params', '<type-params>', parent, span);
    for (const p of params) {
      this.b.bind(id, p.name, 'type-param', p.span);
      if (p.bound !== null) this.expr(p.bound, id);
      if (p.default !== null) this.expr(p.default, id);
    }
    return id;
  }

  private defaults(params: readonly Param[], s: number): void {
    for (const p of params) if (p.default !== null) this.expr(p.default, s);
  }

  private annotations(params: readonly Param[], returns: Expr | null, tp: number): void {
    for (const p of params) if (p.annotation !== null) this.expr(p.annotation, tp);
    if (returns !== null) this.expr(returns, tp);
  }

  private bindParams(params: readonly Param[], scope: number): void {
    for (const p of params) {
      if (p.name !== null) this.b.bind(scope, p.name, 'param', p.span);
    }
  }

  private label(parent: number, name: string): string {
    const p = this.b.at(parent);
    const prefix = p.kind === 'class' || p.kind === 'function' ? `${p.label}.` : '';
    return prefix + name;
  }

  /** A store: an assignment, loop, `with` or annotated target. */
  private target(e: Expr, s: number, kind: BindingKind): void {
    switch (e.kind) {
      case 'name':
        this.b.bind(s, e.id, kind, e.span);
        return;
      case 'tuple':
      case 'list':
        for (const el of e.elements) this.target(el, s, kind);
        return;
      case 'starred':
        this.target(e.value, s, kind);
        return;
      default:
        this.expr(e, s);
    }
  }

  private delete(e: Expr, s: number): void {
    switch (e.kind) {
      case 'name':
        this.b.bind(s, e.id, 'delete', e.span);
        this.b.use(s, e.id, e.span, 'delete');
        return;
      case 'tuple':
      case 'list':
        for (const el of e.elements) this.delete(el, s);
        return;
      default:
        this.expr(e, s);
    }
  }

  private pattern(p: Pattern, s: number): void {
    switch (p.kind) {
      case 'literal':
      case 'value':
        this.expr(p.value, s);
        return;
      case 'capture':
        this.b.bind(s, p.name, 'match', p.span);
        return;
      case 'wildcard':
        return;
      case 'star':
        if (p.name !== null) this.b.bind(s, p.name, 'match', p.span);
        return;
      case 'sequence':
        for (const el of p.elements) this.pattern(el, s);
        return;
      case 'mapping':
        for (const entry of p.entries) {
          this.expr(entry.key, s);
          this.pattern(entry.pattern, s);
        }
        if (p.rest !== null) this.b.bind(s, p.rest, 'match', p.span);
        return;
      case 'class':
        this.expr(p.cls, s);
        for (const el of p.positional) this.pattern(el, s);
        for (const kw of p.keywords) this.pattern(kw.pattern, s);
        return;
      case 'or':
        for (const alt of p.alternatives) this.pattern(alt, s);
        return;
      case 'as':
        this.pattern(p.pattern, s);
        this.b.bind(s, p.name, 'match', p.span);
        return;
    }
  }

  private walrus(target: Expr, value: Expr, s: number): void {
    this.expr(value, s);
    if (target.kind === 'name') this.b.bind(s, target.id, 'walrus', target.span, true);
    else this.expr(target, s);
  }

  private lambda(e: Extract<Expr, { kind: 'lambda' }>, s: number): void {
    this.defaults(e.params, s);
    const l = this.b.scope('lambda', '<lambda>', s, e.span);
    this.bindParams(e.params, l);
    this.expr(e.body, l);
  }

  private comprehension(e: Extract<Expr, { kind: 'comprehension' }>, s: number): void {
    const first = e.generators[0];
    // The first iterable is evaluated in the enclosing scope, as CPython does.
    if (first !== undefined) this.expr(first.iter, s);
    const c = this.b.scope('comprehension', '<comprehension>', s, e.span);
    e.generators.forEach((g, i) => {
      if (i > 0) this.expr(g.iter, c);
      this.target(g.target, c, 'for');
      for (const cond of g.ifs) this.expr(cond, c);
    });
    this.expr(e.element, c);
    if (e.value !== null) this.expr(e.value, c);
  }

  private fstring(parts: readonly FStringPart[], s: number): void {
    for (const part of parts) {
      if (part.kind !== 'field') continue;
      this.expr(part.expr, s);
      if (part.spec !== null) this.fstring(part.spec, s);
    }
  }

  expr(e: Expr, s: number): void {
    switch (e.kind) {
      case 'name':
        this.b.use(s, e.id, e.span);
        return;
      case 'constant':
        return;
      case 'fstring':
        this.fstring(e.parts, s);
        return;
      case 'attribute':
        this.expr(e.value, s);
        return;
      case 'subscript':
        this.expr(e.value, s);
        this.expr(e.index, s);
        return;
      case 'slice':
        for (const part of [e.lower, e.upper, e.step]) if (part !== null) this.expr(part, s);
        return;
      case 'call':
        this.expr(e.func, s);
        for (const arg of e.args) this.expr(arg.value, s);
        return;
      case 'binop':
        this.expr(e.left, s);
        this.expr(e.right, s);
        return;
      case 'unaryop':
        this.expr(e.operand, s);
        return;
      case 'boolop':
        for (const v of e.values) this.expr(v, s);
        return;
      case 'compare':
        this.expr(e.left, s);
        for (const c of e.comparators) this.expr(c, s);
        return;
      case 'ifexp':
        this.expr(e.test, s);
        this.expr(e.body, s);
        this.expr(e.orelse, s);
        return;
      case 'lambda':
        this.lambda(e, s);
        return;
      case 'tuple':
      case 'list':
      case 'set':
        for (const el of e.elements) this.expr(el, s);
        return;
      case 'dict':
        for (const entry of e.entries) {
          if (entry.key !== null) this.expr(entry.key, s);
          this.expr(entry.value, s);
        }
        return;
      case 'comprehension':
        this.comprehension(e, s);
        return;
      case 'starred':
        this.expr(e.value, s);
        return;
      case 'namedexpr':
        this.walrus(e.target, e.value, s);
        return;
      case 'await':
      case 'yieldfrom':
        this.expr(e.value, s);
        return;
      case 'yield':
        if (e.value !== null) this.expr(e.value, s);
        return;
    }
  }
}

/** The nearest enclosing scope that is not a comprehension (where a walrus target binds). */
function nonComprehension(scopes: readonly Scope[], id: number): number {
  let current = scopeAt(scopes, id);
  while (current.kind === 'comprehension' && current.parent !== null) {
    current = scopeAt(scopes, current.parent);
  }
  return current.id;
}

function place(scopes: readonly Scope[], id: number, p: PendingBind): void {
  const scope = scopeAt(scopes, id);
  const binding: Binding = { name: p.name, kind: p.kind, scope: id, span: p.span };
  let list = scope.bindings.get(p.name);
  if (list === undefined) {
    list = [];
    scope.bindings.set(p.name, list);
  }
  list.push(binding);
}

/**
 * The function or lambda scope, above `base`, that a nonlocal name binds in. Class, comprehension
 * and type-parameter scopes are skipped, and the module is never reached.
 */
function nonlocalTarget(scopes: readonly Scope[], name: string, base: number): number | null {
  let s = scopeAt(scopes, base).parent;
  while (s !== null) {
    const scope = scopeAt(scopes, s);
    if (scope.kind === 'module') return null;
    if ((scope.kind === 'function' || scope.kind === 'lambda') && scope.bindings.has(name)) {
      return scope.id;
    }
    s = scope.parent;
  }
  return null;
}

function resolve(scopes: readonly Scope[], name: string, from: number): Resolution {
  const start = scopeAt(scopes, from);
  const isNonlocal = start.nonlocals.has(name);
  let current: Scope | undefined;
  if (start.globals.has(name)) {
    current = scopeAt(scopes, MODULE);
  } else if (isNonlocal) {
    current = start.parent === null ? undefined : scopeAt(scopes, start.parent);
  } else {
    current = start;
  }
  while (current !== undefined) {
    // A class body is visible only to code that runs directly in it.
    const visible = !(current.kind === 'class' && current !== start);
    if (isNonlocal && current.kind === 'module') break;
    if (visible && current.bindings.has(name)) {
      return { kind: 'scope', scope: current.id, scopeKind: current.kind };
    }
    current = current.parent === null ? undefined : scopeAt(scopes, current.parent);
  }
  if (IMPLICIT_MODULE_NAMES.has(name)) return { kind: 'implicit', name };
  // A star import can supply any name, including built-ins, so it is checked first.
  if (scopeAt(scopes, MODULE).hasStarImport) return { kind: 'unresolved', reason: 'star-import' };
  if (BUILTIN_NAMES.has(name)) return { kind: 'builtin', name };
  return { kind: 'unresolved', reason: 'undefined' };
}

/** Analyzes the scopes of one parsed Python module. Never throws on a well-formed AST. */
export function analyzeScopes(body: readonly Stmt[]): ScopeAnalysis {
  const walker = new Walker();
  const module = walker.b.scope('module', '<module>', null, null);
  walker.walkBody(body, module);
  return finish(walker.b);
}

function finish(b: Builder): ScopeAnalysis {
  const scopes = b.scopes;
  const deferred: { readonly bind: PendingBind; readonly base: number }[] = [];

  for (const p of b.binds) {
    const base = p.walrus ? nonComprehension(scopes, p.scope) : p.scope;
    const scope = scopeAt(scopes, base);
    if (scope.globals.has(p.name)) place(scopes, MODULE, p);
    else if (scope.nonlocals.has(p.name)) deferred.push({ bind: p, base });
    else place(scopes, base, p);
  }

  // Every nonlocal declaration needs an enclosing binding, even if the body never assigns the name.
  for (const decl of b.nonlocalDecls) {
    if (nonlocalTarget(scopes, decl.name, decl.scope) === null) {
      b.problems.push({ span: decl.span, message: `no binding for nonlocal '${decl.name}' found` });
    }
  }

  // Nonlocal targets are looked up after every direct binding is placed. A null target was
  // reported with its declaration above.
  for (const { bind, base } of deferred) {
    const target = nonlocalTarget(scopes, bind.name, base);
    if (target !== null) place(scopes, target, bind);
  }

  const uses: NameUse[] = b.uses.map((u) => ({
    name: u.name,
    span: u.span,
    scope: u.scope,
    access: u.access,
    resolution: resolve(scopes, u.name, u.scope),
  }));
  return { scopes, uses, problems: b.problems };
}
