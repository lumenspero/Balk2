/**
 * Rust shared state (V3 Phase 12.3).
 * - Writes to a `static mut`: `COUNT = 1` and `COUNT += 1` inside a function, including `unsafe`.
 *   A compound assignment both reads and writes.
 * - Method calls on an interior-mutable static, found by its declared type. Each method has an
 *   effect from a fixed catalogue: atomics (`Atomic*`), `Mutex` and `RwLock`, `OnceLock` and
 *   `OnceCell`, and `LazyLock`, `LazyCell` and `Lazy`. A method the catalogue does not name is not
 *   read. Every lock acquisition (`lock`, `read`, `write`, `try_*`) is a read, as Phase 12.3 has it.
 *
 * Only a static whose own type is one of these is read. `LazyLock<Mutex<..>>` is not, because its
 * methods belong to the inner type, and `lazy_static!` and `thread_local!` are not read yet.
 *
 * Names are read from the body's tokens, since the body scanner records no assignments or method
 * calls. A name the function binds itself (`let`, a pattern, a closure parameter) is a local. Writes
 * through a field or an index are not read.
 */
import type { Fragment } from '../items.js';
import type { StatePathFact } from '../../../facts/types.js';
import type { BodyFact } from '../body.js';
import type { RustToken } from '../lexer.js';
import { bodyBlocksOf, ownBodyFacts, startsWithin } from '../nested.js';
import { sourceSpanOf } from '../source-span.js';
import { isTokenGroup, type TokenTree } from '../token-tree.js';
import { buildRepo, contextOf, scopeCtx, symbolOf } from './calls.js';
import type { RustCrateIndex } from './module-index.js';
import type { RustNameEnvironment } from './resolve.js';
import { pathOfTokens, readPath } from './type-paths.js';

/** What a method does to the state it is called on. */
type Effect = 'read' | 'write' | 'read-write';

/** The kind of an interior-mutable static, from its declared type. */
type Category = 'atomic' | 'lock' | 'once' | 'lazy';

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

const EFFECTS: Readonly<Record<Category, Readonly<Record<string, Effect>>>> = {
  atomic: ATOMIC_EFFECTS,
  lock: LOCK_EFFECTS,
  once: ONCE_EFFECTS,
  lazy: LAZY_EFFECTS,
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

/** One assignment a body makes to a plain name: the name's token and the operator. */
interface Assignment {
  readonly name: RustToken;
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
): StatePathFact[] {
  const mutable = new Set<string>();
  const interior = new Map<string, Category>();
  for (const crate of crates) {
    for (const decl of crate.decls) {
      if (decl.item.kind !== 'static') continue;
      if (decl.item.mutable) mutable.add(decl.id);
      const category = categoryOf(decl.item.ty);
      if (category !== undefined) interior.set(decl.id, category);
    }
  }
  if (mutable.size === 0 && interior.size === 0) return [];

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
      if (path === null) return undefined;
      const site = scopeCtx(ctx, entry.fn.scopes, token);
      return symbolOf(path, 'value', site.owner, site.crate, site.repo.env);
    };

    for (const assignment of assignmentsIn(body.children)) {
      const target = staticNamed(assignment.name);
      if (target === undefined || !mutable.has(target)) continue;
      facts.push(...assignmentFacts(assignment, target, entry.fn.id, file));
    }
    for (const call of methodCallsIn(body.children)) {
      const target = staticNamed(call.name);
      if (target === undefined) continue;
      const category = interior.get(target);
      if (category === undefined) continue;
      const effect = EFFECTS[category][call.method.value];
      if (effect === undefined) continue;
      facts.push(...callFacts(call, effect, target, entry.fn.id, file));
    }
  }
  return facts;
}

/** The category of a static's declared type: `Atomic*`, or one of the listed interior types. */
function categoryOf(ty: Fragment | null): Category | undefined {
  if (ty === null) return undefined;
  const segments = readPath(ty.tokens).path?.segments ?? [];
  const last = segments[segments.length - 1];
  if (last === undefined) return undefined;
  if (last.startsWith('Atomic')) return 'atomic';
  return TYPE_CATEGORY[last];
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

/** Every assignment to a plain name in a token list, including inside nested groups. */
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
    const after = trees[i + 1];
    if (after === undefined || isTokenGroup(after) || after.kind !== 'punct') continue;
    if (ASSIGNMENTS.has(after.text)) out.push({ name: tree, op: after.text });
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
): StatePathFact[] {
  const compound = assignment.op !== '=';
  const base = {
    kind: 'state-path' as const,
    filePath: file,
    span: sourceSpanOf(assignment.name, file),
    owner,
    rootKind: 'module' as const,
    root,
    segments: [],
    confidence: 'high' as const,
    evidence: 'ast' as const,
    subject: `${assignment.name.value} ${assignment.op}`,
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
