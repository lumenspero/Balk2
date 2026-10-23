/**
 * Calls (V3 Phase 9.6). Every function body is scanned for call sites, and each site that names a
 * function in the repository becomes a `calls` edge from the enclosing function.
 *
 * - A path call (`f()`, `m::f()`, `crate::m::f()`) resolves through scopes and paths, as a value.
 * - `Type::name()` resolves to the inherent method first. Failing that, to the one trait impl in
 *   the repository that gives `Type` the name (medium).
 * - `Self::name()` and `self.m()` resolve within the enclosing impl. In a trait body they resolve
 *   to the trait's method, with dispatch.
 * - `recv.m()` resolves when the receiver's type is known. An annotated parameter or `let` is high;
 *   the result of a resolved function is medium (2.4). `&`, `&mut`, `Box`, `Rc` and `Arc` are peeled.
 * - A receiver typed `dyn Trait`, `impl Trait`, or a generic with one trait bound resolves to that
 *   trait's method, with `metadata.dispatch: 'trait'`.
 *
 * A name bound by a `let`, parameter, `for`, closure or match arm is never resolved to an item.
 * A name bound more than once loses its type. A receiver of unknown type emits no edge.
 * Known gaps: calls inside macro arguments, nested functions (their calls are credited to the
 * outer function), and tuple-struct constructors (they name no function).
 */
import { type BodyFact, scanTokens } from '../body.js';
import { blocksOfTokens, factsOutside, ownBodyFacts, startsWithin } from '../nested.js';
import type { GenericParam, Item, Span } from '../items.js';
import { lexRust, type RustToken } from '../lexer.js';
import { buildTokenTrees, isTokenGroup, type TokenTree } from '../token-tree.js';
import type {
  PendingFunction,
  PendingImpl,
  RustCrateIndex,
  RustModuleNode,
  BodyScope,
} from './module-index.js';
import {
  type RustNameEnvironment,
  type RustPath,
  resolveName,
  type UnresolvedReason,
} from './resolve.js';
import { pathOfTokens, readPath } from './type-paths.js';

export interface CallEdge {
  readonly from: string;
  readonly to: string;
  /** The file of the calling function. */
  readonly file: string;
  /** One span per call site, in source order. */
  readonly spans: readonly Span[];
  readonly confidence: Confidence;
  /** True when the callee is a trait method reached through a `dyn`, `impl` or generic receiver. */
  readonly dispatch: boolean;
}

export interface CallUnresolved {
  readonly file: string;
  readonly span: Span;
  readonly subject: string;
  readonly reason: UnresolvedReason;
  readonly detail: string;
}

export interface CallResults {
  readonly edges: readonly CallEdge[];
  readonly unresolved: readonly CallUnresolved[];
}

type Confidence = 'high' | 'medium';

/** A type a receiver can have: a concrete type, or a trait it is used through. */
type Ty =
  { readonly kind: 'type'; readonly id: string } | { readonly kind: 'trait'; readonly id: string };

interface Typed {
  readonly ty: Ty;
  readonly confidence: Confidence;
}

/** A function a call site resolves to. */
interface Callable {
  readonly id: string;
  readonly confidence: Confidence;
  readonly dispatch: boolean;
}

export interface Entry {
  readonly crate: RustCrateIndex;
  readonly fn: PendingFunction;
}

interface TraitMethod {
  readonly id: string;
  /** False for a required method, which has no body to fall back on. */
  readonly body: boolean;
}

interface ImplInfo {
  readonly impl: PendingImpl;
  /** The self type's symbol id, or null for a blanket impl over a generic. */
  readonly typeId: string | null;
  readonly trait: boolean;
  readonly traitId: string | null;
  /** The method names the impl defines, with their symbol ids. */
  readonly methods: ReadonlyMap<string, string>;
}

export interface Repo {
  readonly env: RustNameEnvironment;
  readonly entries: readonly Entry[];
  readonly fnsById: ReadonlyMap<string, Entry>;
  readonly fnIds: ReadonlySet<string>;
  readonly traitIds: ReadonlySet<string>;
  readonly traitMethods: ReadonlyMap<string, ReadonlyMap<string, TraitMethod>>;
  readonly implsByType: ReadonlyMap<string, readonly ImplInfo[]>;
  readonly implsByItem: ReadonlyMap<Item, ImplInfo>;
}

export interface Ctx {
  readonly repo: Repo;
  readonly crate: RustCrateIndex;
  readonly owner: RustModuleNode;
  /** The type `Self` names: the impl's self type, or the trait inside a trait body. */
  readonly self: Ty | null;
  /** Trait ids that a generic name is bound by, from its inline bounds and `where` clause. */
  readonly bounds: Map<string, string[]>;
}

export type Locals = ReadonlyMap<string, Typed | null>;

interface MutableEdge {
  readonly from: string;
  readonly to: string;
  readonly file: string;
  readonly spans: Span[];
  readonly confidence: Confidence;
  readonly dispatch: boolean;
}

/** Binds the `calls` edges of every function in the repository. Crates are indexed first. */
export function bindCalls(
  crates: readonly RustCrateIndex[],
  env: RustNameEnvironment,
): CallResults {
  const repo = buildRepo(crates, env);
  const edges = new Map<string, MutableEdge>();
  const unresolved: CallUnresolved[] = [];

  /** Binds the calls and method calls of one body, owned by `from`, whose blocks are `scopes`. */
  const bindBody = (
    from: string,
    file: string,
    facts: readonly BodyFact[],
    ctx: Ctx,
    locals: Locals,
    scopes: readonly BodyScope[],
  ): void => {
    const record = (callable: Callable | null, span: Span): void => {
      if (callable === null) return;
      const key = [from, callable.id, callable.confidence, callable.dispatch].join('\u0000');
      const existing = edges.get(key);
      if (existing !== undefined) {
        existing.spans.push(span);
        return;
      }
      edges.set(key, {
        from,
        to: callable.id,
        file,
        spans: [span],
        confidence: callable.confidence,
        dispatch: callable.dispatch,
      });
    };

    for (const fact of facts) {
      if (fact.kind === 'call') {
        const segments = fact.path;
        if (segments.length === 1 && locals.has(segments[0] ?? '')) continue;
        const resolved = resolveCallPath(
          { global: false, segments },
          scopeCtx(ctx, scopes, fact.span),
          locals,
        );
        if (resolved.unresolved !== undefined) {
          unresolved.push({
            file,
            span: fact.span,
            subject: segments.join('::'),
            reason: resolved.unresolved.reason,
            detail: resolved.unresolved.detail,
          });
        } else {
          record(resolved.callable, fact.span);
        }
      } else if (fact.kind === 'method-call') {
        if (fact.receiver === null) continue;
        const typed = receiverOf(fact.receiver, scopeCtx(ctx, scopes, fact.span), locals);
        if (typed === null) continue;
        const callable = memberOf(repo, typed.ty, fact.method);
        if (callable === null) continue;
        record(
          { ...callable, confidence: combine(typed.confidence, callable.confidence) },
          fact.span,
        );
      }
    }
  };

  for (const entry of repo.entries) {
    const body = entry.fn.item.body;
    if (body === null) continue;
    const facts = ownBodyFacts(body);
    const ctx = contextOf(repo, entry);
    const locals = localsOf(entry.fn.item, facts, ctx, (span) =>
      scopeCtx(ctx, entry.fn.scopes, span),
    );
    bindBody(entry.fn.id, entry.fn.owner.file, facts, ctx, locals, entry.fn.scopes);
  }

  // Calls inside a const or static value (9.8). Its `let`s are tracked like a body's.
  for (const crate of crates) {
    for (const decl of crate.decls) {
      const item = decl.item;
      if ((item.kind !== 'const' && item.kind !== 'static') || item.value === null) continue;
      const facts = factsOutside(scanTokens(item.value.tokens), blocksOfTokens(item.value.tokens));
      const ctx: Ctx = { repo, crate, owner: decl.owner, self: null, bounds: new Map() };
      const locals = localsOf({ params: [] }, facts, ctx, (span) =>
        scopeCtx(ctx, decl.scopes, span),
      );
      bindBody(decl.id, decl.owner.file, facts, ctx, locals, decl.scopes);
    }
  }

  return { edges: [...edges.values()], unresolved };
}

// ── The repository index ─────────────────────────────────────

export function buildRepo(crates: readonly RustCrateIndex[], env: RustNameEnvironment): Repo {
  const entries: Entry[] = [];
  for (const crate of crates) {
    for (const fn of crate.functions) entries.push({ crate, fn });
  }
  const fnsById = new Map<string, Entry>();
  const fnIds = new Set<string>();
  for (const entry of entries) {
    if (!fnsById.has(entry.fn.id)) fnsById.set(entry.fn.id, entry);
    fnIds.add(entry.fn.id);
  }

  const traitIds = new Set<string>();
  for (const crate of crates) {
    for (const trait of crate.traits) {
      const id = declaredId(trait.owner, trait.name);
      if (id !== undefined) traitIds.add(id);
    }
  }

  const traitMethods = new Map<string, Map<string, TraitMethod>>();
  const methodsByItem = new Map<Item, Map<string, string>>();
  for (const { fn } of entries) {
    const container = fn.container;
    if (container?.kind === 'trait') {
      const id = declaredId(fn.owner, container.name);
      if (id === undefined) continue;
      const methods = traitMethods.get(id) ?? new Map<string, TraitMethod>();
      methods.set(fn.item.name, { id: fn.id, body: fn.item.body !== null });
      traitMethods.set(id, methods);
    } else if (container?.kind === 'impl') {
      const methods = methodsByItem.get(container) ?? new Map<string, string>();
      methods.set(fn.item.name, fn.id);
      methodsByItem.set(container, methods);
    }
  }

  const implsByType = new Map<string, ImplInfo[]>();
  const implsByItem = new Map<Item, ImplInfo>();
  for (const crate of crates) {
    for (const impl of crate.impls) {
      const selfPath = pathOfTokens(impl.selfTy.tokens);
      const generic =
        selfPath !== null &&
        selfPath.segments.length === 1 &&
        impl.generics.includes(selfPath.segments[0] ?? '');
      const typeId =
        selfPath === null || generic ? null : symbolOf(selfPath, 'type', impl.owner, crate, env);
      const traitPath = impl.trait === null ? null : pathOfTokens(impl.trait.tokens);
      const traitId =
        traitPath === null ? null : (symbolOf(traitPath, 'type', impl.owner, crate, env) ?? null);
      const info: ImplInfo = {
        impl,
        typeId: typeId ?? null,
        trait: impl.trait !== null,
        traitId,
        methods: methodsByItem.get(impl.item) ?? new Map<string, string>(),
      };
      implsByItem.set(impl.item, info);
      if (info.typeId !== null) {
        const list = implsByType.get(info.typeId) ?? [];
        list.push(info);
        implsByType.set(info.typeId, list);
      }
    }
  }

  return { env, entries, fnsById, fnIds, traitIds, traitMethods, implsByType, implsByItem };
}

/** The symbol a path names in a namespace, when it names a symbol in the repository. */
export function symbolOf(
  path: RustPath,
  ns: 'type' | 'value',
  owner: RustModuleNode,
  crate: RustCrateIndex,
  env: RustNameEnvironment,
): string | undefined {
  const resolution = resolveName(path, ns, owner, crate, env);
  return resolution.kind === 'symbol' ? resolution.id : undefined;
}

/** The id of an item declared by name in a module's own scope. */
export function declaredId(owner: RustModuleNode, name: string): string | undefined {
  for (
    let scope: RustModuleNode | null = owner;
    scope !== null;
    scope = scope.block ? scope.parent : null
  ) {
    const id = scope.tables.get(scope.scope)?.type.get(name);
    if (id !== undefined) return id;
  }
  return undefined;
}

// ── Member lookup ────────────────────────────────────────────

function combine(a: Confidence, b: Confidence): Confidence {
  return a === 'high' && b === 'high' ? 'high' : 'medium';
}

/** The method `name` on a type or trait. Inherent first; then one trait impl, at medium. */
function memberOf(repo: Repo, ty: Ty | null, name: string): Callable | null {
  if (ty === null) return null;
  if (ty.kind === 'trait') {
    const method = repo.traitMethods.get(ty.id)?.get(name);
    return method === undefined ? null : { id: method.id, confidence: 'high', dispatch: true };
  }
  const inherent = inherentMethod(repo, ty.id, name);
  if (inherent !== undefined) return { id: inherent, confidence: 'high', dispatch: false };
  const traitImpl = traitMethodOf(repo, ty.id, name);
  if (traitImpl !== undefined) return { id: traitImpl, confidence: 'medium', dispatch: false };
  return null;
}

function inherentMethod(repo: Repo, typeId: string, name: string): string | undefined {
  for (const info of repo.implsByType.get(typeId) ?? []) {
    if (info.trait) continue;
    const id = info.methods.get(name);
    if (id !== undefined) return id;
  }
  return undefined;
}

/** The one trait method `name` that trait impls give the type, or undefined when there are none or several. */
function traitMethodOf(repo: Repo, typeId: string, name: string): string | undefined {
  const ids = new Set<string>();
  for (const info of repo.implsByType.get(typeId) ?? []) {
    if (!info.trait) continue;
    const own = info.methods.get(name);
    if (own !== undefined) {
      ids.add(own);
      continue;
    }
    if (info.traitId === null) continue;
    const fallback = repo.traitMethods.get(info.traitId)?.get(name);
    if (fallback?.body === true) ids.add(fallback.id);
  }
  return ids.size === 1 ? [...ids][0] : undefined;
}

// ── Call paths ───────────────────────────────────────────────

interface CallResolution {
  readonly callable: Callable | null;
  readonly unresolved?: { readonly reason: UnresolvedReason; readonly detail: string };
}

const NO_CALL: CallResolution = { callable: null };

function resolveCallPath(path: RustPath, ctx: Ctx, locals: Locals): CallResolution {
  const { segments } = path;
  if (!path.global && segments.length === 2 && segments[0] === 'Self') {
    return { callable: memberOf(ctx.repo, ctx.self, segments[1] ?? '') };
  }
  if (!path.global && segments.length === 1 && locals.has(segments[0] ?? '')) return NO_CALL;

  const resolution = resolveName(path, 'value', ctx.owner, ctx.crate, ctx.repo.env);
  switch (resolution.kind) {
    case 'symbol':
      return ctx.repo.fnIds.has(resolution.id)
        ? { callable: { id: resolution.id, confidence: 'high', dispatch: false } }
        : NO_CALL;
    case 'associated': {
      if (resolution.rest.length !== 1) return NO_CALL;
      const ty: Ty = ctx.repo.traitIds.has(resolution.id)
        ? { kind: 'trait', id: resolution.id }
        : { kind: 'type', id: resolution.id };
      return { callable: memberOf(ctx.repo, ty, resolution.rest[0] ?? '') };
    }
    case 'unresolved':
      return {
        callable: null,
        unresolved: { reason: resolution.reason, detail: resolution.detail },
      };
    default:
      return NO_CALL;
  }
}

// ── Local types (2.4) ────────────────────────────────────────

/** The type of each local name in a function. A name bound twice, or by a pattern, has none. */
export function localsOf(
  fn: { readonly params: PendingFunction['item']['params'] },
  facts: readonly BodyFact[],
  ctx: Ctx,
  scoped: (span: Span) => Ctx = () => ctx,
): Locals {
  const map = new Map<string, Typed | null>();
  const bind = (name: string, typed: Typed | null): void => {
    map.set(name, map.has(name) ? null : typed);
  };

  for (const param of fn.params) {
    if (param.kind !== 'typed') continue;
    const name = plainName(param.pattern);
    if (name === null) continue;
    const ty = typeOf(param.type.tokens, ctx);
    bind(name, ty === null ? null : { ty, confidence: 'high' });
  }

  for (const fact of facts) {
    if (fact.kind === 'let') {
      const [only] = fact.bindings;
      if (fact.bindings.length !== 1 || only === undefined || !fact.simple) {
        for (const binding of fact.bindings) bind(binding.name, null);
        continue;
      }
      let typed: Typed | null = null;
      if (fact.type !== null) {
        const ty = typeOf(fact.type.tokens, scoped(fact.span));
        typed = ty === null ? null : { ty, confidence: 'high' };
      } else if (fact.init !== null) {
        typed = typeOfInit(fact.init, scoped(fact.span));
      }
      bind(only.name, typed);
    } else if (fact.kind === 'for' || fact.kind === 'match-arm') {
      for (const binding of fact.bindings) bind(binding.name, null);
    } else if (fact.kind === 'closure') {
      for (const binding of fact.params) bind(binding.name, null);
    }
  }
  return map;
}

/** The name a pattern binds when it is one plain identifier, with an optional `mut`. */
function plainName(pattern: string): string | null {
  const match = /^(?:mut\s+)?([A-Za-z_]\w*)$/.exec(pattern.trim());
  return match?.[1] ?? null;
}

function receiverOf(receiver: string, ctx: Ctx, locals: Locals): Typed | null {
  if (receiver === 'self') return ctx.self === null ? null : { ty: ctx.self, confidence: 'high' };
  return locals.get(receiver) ?? null;
}

/** The type a `let` initializer gives: a struct literal, or the result of a resolved function. */
function typeOfInit(init: readonly TokenTree[], ctx: Ctx): Typed | null {
  const { path, end } = readPath(init);
  if (path === null) return null;
  const next = init[end];
  if (next === undefined || !isTokenGroup(next)) return null;
  if (next.delimiter === '{') {
    const ty = typeOf(init.slice(0, end), ctx);
    return ty?.kind === 'type' ? { ty, confidence: 'high' } : null;
  }
  if (next.delimiter !== '(') return null;
  const callable = resolveCallPath(path, ctx, new Map()).callable;
  if (callable === null || callable.dispatch) return null;
  const ty = returnTypeOf(ctx.repo, callable.id);
  return ty === null ? null : { ty, confidence: 'medium' };
}

function returnTypeOf(repo: Repo, id: string): Ty | null {
  const entry = repo.fnsById.get(id);
  const ret = entry?.fn.item.ret;
  if (entry === undefined || ret === null || ret === undefined) return null;
  return typeOf(ret.tokens, contextOf(repo, entry));
}

/**
 * The type a token list names. `&`, `&mut`, lifetimes, `Box`, `Rc` and `Arc` are peeled. `dyn` and
 * `impl` name the trait they are used through. A generic name is its single bound trait.
 */
function typeOf(trees: readonly TokenTree[], ctx: Ctx): Ty | null {
  let k = 0;
  while (k < trees.length && isRefPrefix(trees[k])) k += 1;
  const rest = trees.slice(k);
  const first = rest[0];
  if (isWordTree(first, 'dyn') || isWordTree(first, 'impl')) {
    const path = pathOfTokens(rest.slice(1));
    const id =
      path === null ? undefined : symbolOf(path, 'type', ctx.owner, ctx.crate, ctx.repo.env);
    return id !== undefined && ctx.repo.traitIds.has(id) ? { kind: 'trait', id } : null;
  }

  const { path, end } = readPath(rest);
  if (path === null) return null;
  const last = path.segments[path.segments.length - 1] ?? '';
  if (!path.global && path.segments.length === 1 && last === 'Self') return ctx.self;
  if (!path.global && (last === 'Box' || last === 'Rc' || last === 'Arc')) {
    const inner = angleArgs(rest, end);
    return inner === null ? null : typeOf(inner, ctx);
  }
  if (!path.global && path.segments.length === 1) {
    const bounds = ctx.bounds.get(last);
    if (bounds !== undefined) {
      const [only] = bounds;
      return bounds.length === 1 && only !== undefined ? { kind: 'trait', id: only } : null;
    }
  }
  const id = symbolOf(path, 'type', ctx.owner, ctx.crate, ctx.repo.env);
  if (id === undefined) return null;
  return ctx.repo.traitIds.has(id) ? { kind: 'trait', id } : { kind: 'type', id };
}

export function contextOf(repo: Repo, entry: Entry): Ctx {
  const { crate, fn } = entry;
  const container = fn.container;
  let self: Ty | null = null;
  const generics: GenericParam[] = [...fn.item.generics];
  if (container?.kind === 'impl') {
    const info = repo.implsByItem.get(container);
    self = info !== undefined && info.typeId !== null ? { kind: 'type', id: info.typeId } : null;
    generics.push(...container.generics);
  } else if (container?.kind === 'trait') {
    const id = declaredId(fn.owner, container.name);
    self = id === undefined ? null : { kind: 'trait', id };
  }
  const ctx: Ctx = { repo, crate, owner: fn.owner, self, bounds: new Map() };
  fillBounds(ctx, generics, fn.item.where);
  return ctx;
}

/** Records the trait ids each generic name is bound by, from its inline bounds and `where` clause. */
export function fillBounds(ctx: Ctx, generics: readonly GenericParam[], where: string): void {
  const texts: [string, string][] = [];
  for (const generic of generics) {
    if (generic.kind !== 'type') continue;
    const colon = generic.raw.indexOf(':');
    if (colon < 0) continue;
    texts.push([generic.name, (generic.raw.slice(colon + 1).split('=')[0] ?? '').trim()]);
  }
  for (const match of where.matchAll(/([A-Za-z_]\w*)\s*:\s*([^,]+)/g)) {
    texts.push([match[1] ?? '', (match[2] ?? '').trim()]);
  }
  for (const [name, text] of texts) {
    for (const piece of text.split('+')) {
      const path = pathOfTokens(buildTokenTrees(lexRust(piece.trim()).tokens).trees);
      if (path === null) continue;
      const id = symbolOf(path, 'type', ctx.owner, ctx.crate, ctx.repo.env);
      if (id === undefined || !ctx.repo.traitIds.has(id)) continue;
      const list = ctx.bounds.get(name) ?? [];
      list.push(id);
      ctx.bounds.set(name, list);
    }
  }
}

// ── Token helpers ────────────────────────────────────────────

function isWordTree(tree: TokenTree | undefined, word: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'ident' && tree.value === word;
}

function isPunctTree(tree: TokenTree | undefined, text: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'punct' && tree.text === text;
}

/** `&`, `&&`, `mut` and lifetimes, which do not change the type a reference names. */
function isRefPrefix(tree: TokenTree | undefined): boolean {
  if (tree === undefined || isTokenGroup(tree)) return false;
  return (
    (tree.kind === 'punct' && (tree.text === '&' || tree.text === '&&')) ||
    tree.kind === 'lifetime' ||
    isWordTree(tree, 'mut')
  );
}

function angleDelta(tree: TokenTree): number {
  if (isTokenGroup(tree) || tree.kind !== 'punct') return 0;
  const token: RustToken = tree;
  if (token.text === '<') return 1;
  if (token.text === '<<') return 2;
  if (token.text === '>') return -1;
  if (token.text === '>>') return -2;
  return 0;
}

/**
 * The first generic argument of the `<...>` list that starts at `start`, or null when the list does
 * not start there. Only the tokens of the first argument are returned.
 */
function angleArgs(trees: readonly TokenTree[], start: number): TokenTree[] | null {
  if (!isPunctTree(trees[start], '<')) return null;
  let depth = 0;
  const inner: TokenTree[] = [];
  for (let k = start; k < trees.length; k += 1) {
    const tree = trees[k];
    if (tree === undefined) break;
    depth += angleDelta(tree);
    if (depth <= 0) return inner;
    if (depth === 1 && isPunctTree(tree, ',')) return inner;
    if (k > start) inner.push(tree);
  }
  return null;
}

/** The context a span resolves in: the innermost block scope that holds it, else the function's own (9.8). */
export function scopeCtx(ctx: Ctx, scopes: readonly BodyScope[], span: Span): Ctx {
  let owner: RustModuleNode | undefined;
  for (const scope of scopes) {
    if (startsWithin(span, scope.span)) owner = scope.owner;
  }
  return owner === undefined || owner === ctx.owner ? ctx : { ...ctx, owner };
}
