/**
 * Rust shared state (V3 Phase 12.3).
 * - Writes to a `static mut`: `COUNT = 1` and `COUNT += 1` inside a function, including `unsafe`.
 *   A compound assignment both reads and writes.
 * - Method calls on an interior-mutable static, found by its declared type. Each method has an
 *   effect from a fixed catalogue: atomics (`Atomic*`), `Mutex` and `RwLock`, `OnceLock` and
 *   `OnceCell`, and `LazyLock`, `LazyCell` and `Lazy`. A method the catalogue does not name is not
 *   read. Every lock acquisition (`lock`, `read`, `write`, `try_*`) is a read, as Phase 12.3 has it.
 *
 * A `LazyLock<Mutex<..>>` is read as both wrapper and inner type. `lazy_static!` statics are read
 * by their declared type. A `thread_local!` static is read by its `LocalKey` methods: `with`,
 * `with_borrow` and `get` are reads, `with_borrow_mut`, `set`, `take` and `replace` are writes.
 * Writes made inside a `with` closure are not read.
 *
 * A configured singleton (`state.singletons`, matched by module and export) is also read through its
 * fields: `STORE.count = 1` writes the singleton at field `count`, and `STORE.a.b = 1` writes `a.b`.
 * Reads of its fields are not recorded yet.
 *
 * Names are read from the body's tokens, since the body scanner records no assignments or method
 * calls. A name the function binds itself (`let`, a pattern, a closure parameter) is a local. Writes
 * through a field are read only for a configured singleton, and writes through an index are not read.
 */
import type { StatePathFact } from '../../../facts/types.js';
import type { BodyFact } from '../body.js';
import type { StateSingleton } from '../../../config/state-config.js';
import type { RustToken } from '../lexer.js';
import { bodyBlocksOf, ownBodyFacts, startsWithin } from '../nested.js';
import { sourceSpanOf } from '../source-span.js';
import { isTokenGroup, type TokenTree } from '../token-tree.js';
import { lazyStaticsOf } from './lazy-statics.js';
import { buildRepo, contextOf, scopeCtx, symbolOf } from './calls.js';
import type { RustCrateIndex } from './module-index.js';
import type { RustNameEnvironment } from './resolve.js';
import { pathOfTokens, readPath } from './type-paths.js';

/** What a method does to the state it is called on. */
type Effect = 'read' | 'write' | 'read-write';

/** The kind of an interior-mutable static, from its declared type. */
type Category = 'atomic' | 'lock' | 'once' | 'lazy' | 'local';

const ATOMIC_EFFECTS: Readonly<Record<string, Effect>> = {
  load: 'read',
  store: 'write',
  swap: 'read-write',
  fetch_add: 'read-write',
  fetch_sub: 'read-write',
  fetch_and: 'read-write',
  fetch_nand: 'read-write',
  fetch_or: 'read-write',
  fetch_xor: 'read-write',
  fetch_max: 'read-write',
  fetch_min: 'read-write',
  fetch_update: 'read-write',
  compare_exchange: 'read-write',
  compare_exchange_weak: 'read-write',
  compare_and_swap: 'read-write',
};

const LOCK_EFFECTS: Readonly<Record<string, Effect>> = {
  lock: 'read',
  try_lock: 'read',
  read: 'read',
  try_read: 'read',
  write: 'read',
  try_write: 'read',
};

const ONCE_EFFECTS: Readonly<Record<string, Effect>> = {
  get: 'read',
  set: 'write',
  take: 'write',
  initialize: 'write',
  get_or_init: 'read-write',
  get_or_try_init: 'read-write',
};

const LAZY_EFFECTS: Readonly<Record<string, Effect>> = { force: 'read' };

/** `LocalKey` methods on a `thread_local!` static. `with` hands the closure the value, so it is a read. */
const LOCAL_EFFECTS: Readonly<Record<string, Effect>> = {
  with: 'read',
  with_borrow: 'read',
  with_borrow_mut: 'write',
  get: 'read',
  set: 'write',
  take: 'write',
  replace: 'write',
};

const EFFECTS: Readonly<Record<Category, Readonly<Record<string, Effect>>>> = {
  atomic: ATOMIC_EFFECTS,
  lock: LOCK_EFFECTS,
  once: ONCE_EFFECTS,
  lazy: LAZY_EFFECTS,
  local: LOCAL_EFFECTS,
};

/** The category of each non-atomic type a static may be declared with. */
const TYPE_CATEGORY: Readonly<Record<string, Category>> = {
  Mutex: 'lock',
  RwLock: 'lock',
  OnceLock: 'once',
  OnceCell: 'once',
  LazyLock: 'lazy',
  LazyCell: 'lazy',
  Lazy: 'lazy',
};

/** One assignment a body makes to a name, or to a field chain below it: the token, fields and operator. */
interface Assignment {
  readonly name: RustToken;
  readonly fields: readonly string[];
  readonly op: string;
}

/** One method call a body makes on a plain name: the receiver's token and the method's token. */
interface MethodCall {
  readonly name: RustToken;
  readonly method: RustToken;
}

const ASSIGNMENTS: ReadonlySet<string> = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<=',
  '>>=',
]);

/** The state-path facts of every write to a `static mut`, and every method call on an interior static. */
export function rustStateFacts(
  crates: readonly RustCrateIndex[],
  env: RustNameEnvironment,
  config: readonly StateSingleton[] = [],
): StatePathFact[] {
  const mutable = new Set<string>();
  const interior = new Map<string, Category[]>();
  const singletonIds = new Set(config.map((s) => `${s.module}:${s.export}`));
  const singletons = new Set<string>();
  // A `lazy_static!` static is not in the symbol namespace, so it is found by its file and name.
  const lazyNames = new Map<string, string | null>();
  for (const crate of crates) {
    for (const decl of crate.decls) {
      if (decl.item.kind !== 'static') continue;
      if (decl.item.mutable) mutable.add(decl.id);
      if (singletonIds.has(decl.id)) singletons.add(decl.id);
      const categories = categoriesOf(decl.item.ty?.tokens ?? null);
      if (categories.length > 0) interior.set(decl.id, categories);
    }
    for (const call of crate.macroCalls) {
      const macro = call.path[call.path.length - 1];
      if (macro !== 'lazy_static' && macro !== 'thread_local') continue;
      const file = call.owner.file;
      for (const lazy of lazyStaticsOf(call.args.children)) {
        const id = `${file}:${lazy.name}`;
        const key = nameKey(file, lazy.name);
        lazyNames.set(key, lazyNames.has(key) ? null : id);
        if (singletonIds.has(id)) singletons.add(id);
        const categories: Category[] =
          macro === 'thread_local' ? ['local'] : categoriesOf(lazy.type);
        if (categories.length > 0) interior.set(id, categories);
      }
    }
  }
  if (mutable.size === 0 && interior.size === 0 && singletons.size === 0) return [];

  const repo = buildRepo(crates, env);
  const facts: StatePathFact[] = [];
  for (const entry of repo.entries) {
    const body = entry.fn.item.body;
    if (body === null) continue;
    const file = entry.fn.owner.file;
    const locals = localNamesOf(ownBodyFacts(body));
    letNamesIn(body.children, locals);
    const nested = bodyBlocksOf(body).flatMap((block) => block.items);
    const ctx = contextOf(repo, entry);
    const staticNamed = (token: RustToken): string | undefined => {
      if (locals.has(token.value) || nested.some((item) => startsWithin(token, item.span))) {
        return undefined;
      }
      const path = pathOfTokens([token]);
      const site = scopeCtx(ctx, entry.fn.scopes, token);
      const found =
        path === null ? undefined : symbolOf(path, 'value', site.owner, site.crate, site.repo.env);
      if (found !== undefined) return found;
      return lazyNames.get(nameKey(file, token.value)) ?? undefined;
    };

    for (const assignment of assignmentsIn(body.children)) {
      const target = staticNamed(assignment.name);
      if (target === undefined) continue;
      const singleton = singletons.has(target);
      // Only a configured singleton is read through its fields; a `static mut` is read as a whole.
      if (!singleton && (!mutable.has(target) || assignment.fields.length > 0)) continue;
      facts.push(...assignmentFacts(assignment, target, entry.fn.id, file, singleton));
    }
    for (const call of methodCallsIn(body.children)) {
      const target = staticNamed(call.name);
      if (target === undefined) continue;
      const categories = interior.get(target);
      if (categories === undefined) continue;
      const effect = effectOf(categories, call.method.value);
      if (effect === undefined) continue;
      facts.push(...callFacts(call, effect, target, entry.fn.id, file));
    }
  }
  return facts;
}

function nameKey(file: string, name: string): string {
  return JSON.stringify([file, name]);
}

/** The category a type name stands for: `Atomic*`, or one of the listed interior types. */
function categoryNamed(name: string | undefined): Category | undefined {
  if (name === undefined) return undefined;
  if (name.startsWith('Atomic')) return 'atomic';
  return own(TYPE_CATEGORY, name);
}

/**
 * The categories of a static's declared type. The outer type counts, and a lazy wrapper's own
 * argument counts too, so `LazyLock<Mutex<T>>` is both `lazy` and `lock`.
 */
function categoriesOf(tokens: readonly TokenTree[] | null): Category[] {
  if (tokens === null) return [];
  const outer = categoryNamed(lastSegment(tokens));
  if (outer === undefined) return [];
  const out: Category[] = [outer];
  if (outer === 'lazy') {
    const open = tokens.findIndex((t) => !isTokenGroup(t) && t.kind === 'punct' && t.text === '<');
    const inner = categoryNamed(lastSegment(tokens.slice(open + 1)));
    if (open >= 0 && inner !== undefined) out.push(inner);
  }
  return out;
}

/** The last segment of the path at the start of a token list, such as `Mutex` in `Mutex<T>`. */
function lastSegment(tokens: readonly TokenTree[]): string | undefined {
  const segments = readPath(tokens).path?.segments ?? [];
  return segments[segments.length - 1];
}

/** The effect of a method on the first category whose catalogue names it. */
function effectOf(categories: readonly Category[], method: string): Effect | undefined {
  for (const category of categories) {
    const effect = own(EFFECTS[category], method);
    if (effect !== undefined) return effect;
  }
  return undefined;
}

/** A table lookup that ignores inherited keys, so a method called `constructor` finds nothing. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** The names a body binds to locals: `let`, `for`, match arms and closure parameters. */
function localNamesOf(facts: readonly BodyFact[]): Set<string> {
  const names = new Set<string>();
  for (const fact of facts) {
    if (fact.kind === 'let' || fact.kind === 'for' || fact.kind === 'match-arm') {
      for (const binding of fact.bindings) names.add(binding.name);
    } else if (fact.kind === 'closure') {
      for (const param of fact.params) names.add(param.name);
    }
  }
  return names;
}

/**
 * The names a `let` binds, read from the tokens. The pattern scanner leaves out capitalised names,
 * which are usually constants, so a `let` of one is added here.
 */
function letNamesIn(trees: readonly TokenTree[], out: Set<string>): void {
  for (let i = 0; i < trees.length; i += 1) {
    const tree = trees[i];
    if (tree === undefined) continue;
    if (isTokenGroup(tree)) {
      letNamesIn(tree.children, out);
      continue;
    }
    if (tree.kind !== 'ident' || tree.value !== 'let') continue;
    let j = i + 1;
    const next = trees[j];
    if (next !== undefined && !isTokenGroup(next) && next.value === 'mut') j += 1;
    const name = trees[j];
    if (name !== undefined && !isTokenGroup(name) && name.kind === 'ident') out.add(name.value);
  }
}

/** True when a token is `.` or `::`, so the identifier after it is a field or a path segment. */
function continuesPath(tree: TokenTree | undefined): boolean {
  return tree !== undefined && !isTokenGroup(tree) && (tree.text === '.' || tree.text === '::');
}

/** The field names of a `.a.b` chain that starts at `start`, and the index just past the chain. */
function fieldChainAt(
  trees: readonly TokenTree[],
  start: number,
): { fields: string[]; next: number } {
  const fields: string[] = [];
  let j = start;
  for (;;) {
    const dot = trees[j];
    const field = trees[j + 1];
    if (dot === undefined || isTokenGroup(dot) || dot.text !== '.') break;
    if (field === undefined || isTokenGroup(field) || field.kind !== 'ident') break;
    fields.push(field.value);
    j += 2;
  }
  return { fields, next: j };
}

/** Every assignment to a name, or to a field chain below it, in a token list, including nested groups. */
function assignmentsIn(trees: readonly TokenTree[]): Assignment[] {
  const out: Assignment[] = [];
  for (let i = 0; i < trees.length; i += 1) {
    const tree = trees[i];
    if (tree === undefined) continue;
    if (isTokenGroup(tree)) {
      out.push(...assignmentsIn(tree.children));
      continue;
    }
    if (tree.kind !== 'ident' || continuesPath(trees[i - 1])) continue;
    const before = trees[i - 1];
    if (
      before !== undefined &&
      !isTokenGroup(before) &&
      (before.text === 'let' || before.text === 'mut')
    ) {
      continue;
    }
    const { fields, next } = fieldChainAt(trees, i + 1);
    const after = trees[next];
    if (after === undefined || isTokenGroup(after) || after.kind !== 'punct') continue;
    if (ASSIGNMENTS.has(after.text)) out.push({ name: tree, fields, op: after.text });
  }
  return out;
}

/** Every method call `name.method(..)` on a plain name in a token list, including nested groups. */
function methodCallsIn(trees: readonly TokenTree[]): MethodCall[] {
  const out: MethodCall[] = [];
  for (let i = 0; i < trees.length; i += 1) {
    const tree = trees[i];
    if (tree === undefined) continue;
    if (isTokenGroup(tree)) {
      out.push(...methodCallsIn(tree.children));
      continue;
    }
    if (tree.kind !== 'ident' || continuesPath(trees[i - 1])) continue;
    const dot = trees[i + 1];
    const method = trees[i + 2];
    const args = trees[i + 3];
    if (dot === undefined || isTokenGroup(dot) || dot.text !== '.') continue;
    if (method === undefined || isTokenGroup(method) || method.kind !== 'ident') continue;
    if (args === undefined || !isTokenGroup(args) || args.open.text !== '(') continue;
    out.push({ name: tree, method });
  }
  return out;
}

/** A write to a `static mut`: a plain assignment, or a compound one that also reads. */
function assignmentFacts(
  assignment: Assignment,
  root: string,
  owner: string,
  file: string,
  singleton: boolean,
): StatePathFact[] {
  const compound = assignment.op !== '=';
  const base = {
    kind: 'state-path' as const,
    filePath: file,
    span: sourceSpanOf(assignment.name, file),
    owner,
    rootKind: singleton ? ('singleton' as const) : ('module' as const),
    root,
    segments: [...assignment.fields],
    confidence: 'high' as const,
    evidence: 'ast' as const,
    subject: `${[assignment.name.value, ...assignment.fields].join('.')} ${assignment.op}`,
  };
  const out: StatePathFact[] = [];
  if (compound) out.push({ ...base, relationship: 'readsState', operation: 'compound-assign' });
  out.push({
    ...base,
    relationship: 'writesState',
    operation: compound ? 'compound-assign' : 'assign',
  });
  return out;
}

/** A method call on an interior-mutable static, recorded as a `call` on that state. */
function callFacts(
  call: MethodCall,
  effect: Effect,
  root: string,
  owner: string,
  file: string,
): StatePathFact[] {
  const base = {
    kind: 'state-path' as const,
    filePath: file,
    span: sourceSpanOf(call.name, file),
    owner,
    rootKind: 'module' as const,
    root,
    segments: [],
    confidence: 'high' as const,
    evidence: 'ast' as const,
    operation: 'call' as const,
    method: call.method.value,
    subject: `${call.name.value}.${call.method.value}`,
  };
  const out: StatePathFact[] = [];
  if (effect !== 'write') out.push({ ...base, relationship: 'readsState' });
  if (effect !== 'read') out.push({ ...base, relationship: 'writesState' });
  return out;
}
