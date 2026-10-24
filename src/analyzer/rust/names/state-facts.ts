/**
 * Rust shared state (V3 Phase 12.3): writes to a `static mut`. In
 * `pub fn bump() { unsafe { COUNT += 1; } }`, `bump` writes and reads the static `COUNT`, whatever
 * its module, as long as the name resolves to it. A compound assignment both reads and writes.
 *
 * Assignments are read from the body's tokens, so a write inside `unsafe` is found. A name that the
 * function binds itself (`let`, a pattern, a closure parameter) is a local, not the static. Writes
 * through a field or an index (`COUNT[0] = 1`) are not read in this phase.
 */
import type { StatePathFact } from '../../../facts/types.js';
import type { BodyFact } from '../body.js';
import type { RustToken } from '../lexer.js';
import { bodyBlocksOf, ownBodyFacts, startsWithin } from '../nested.js';
import { sourceSpanOf } from '../source-span.js';
import { isTokenGroup, type TokenTree } from '../token-tree.js';
import { buildRepo, scopeCtx, contextOf, symbolOf } from './calls.js';
import type { RustCrateIndex } from './module-index.js';
import type { RustNameEnvironment } from './resolve.js';
import { pathOfTokens } from './type-paths.js';

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

/** One assignment a body makes to a plain name: the name's token and the operator. */
interface Assignment {
  readonly name: RustToken;
  readonly op: string;
}

/** The state-path facts of every write to a `static mut` in a function body. */
export function rustStateFacts(
  crates: readonly RustCrateIndex[],
  env: RustNameEnvironment,
): StatePathFact[] {
  const mutable = new Set<string>();
  for (const crate of crates) {
    for (const decl of crate.decls) {
      if (decl.item.kind === 'static' && decl.item.mutable) mutable.add(decl.id);
    }
  }
  if (mutable.size === 0) return [];

  const repo = buildRepo(crates, env);
  const facts: StatePathFact[] = [];
  for (const entry of repo.entries) {
    const body = entry.fn.item.body;
    if (body === null) continue;
    const file = entry.fn.owner.file;
    const bodyFacts = ownBodyFacts(body);
    const locals = localNamesOf(bodyFacts);
    letNamesIn(body.children, locals);
    const nested = bodyBlocksOf(body).flatMap((block) => block.items);
    const ctx = contextOf(repo, entry);
    for (const assignment of assignmentsIn(body.children)) {
      if (locals.has(assignment.name.value)) continue;
      if (nested.some((item) => startsWithin(assignment.name, item.span))) continue;
      const path = pathOfTokens([assignment.name]);
      if (path === null) continue;
      const site = scopeCtx(ctx, entry.fn.scopes, assignment.name);
      const target = symbolOf(path, 'value', site.owner, site.crate, site.repo.env);
      if (target === undefined || !mutable.has(target)) continue;
      facts.push(...factsOf(assignment, target, entry.fn.id, file));
    }
  }
  return facts;
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

/** Every assignment to a plain name in a token list, including inside nested groups. */
function assignmentsIn(trees: readonly TokenTree[]): Assignment[] {
  const out: Assignment[] = [];
  trees.forEach((tree, i) => {
    if (isTokenGroup(tree)) {
      out.push(...assignmentsIn(tree.children));
      return;
    }
    if (tree.kind !== 'ident') return;
    const before = trees[i - 1];
    if (
      before !== undefined &&
      !isTokenGroup(before) &&
      (before.text === '.' || before.text === '::')
    ) {
      return;
    }
    if (
      before !== undefined &&
      !isTokenGroup(before) &&
      (before.text === 'let' || before.text === 'mut')
    ) {
      return;
    }
    const after = trees[i + 1];
    if (after === undefined || isTokenGroup(after) || after.kind !== 'punct') return;
    if (ASSIGNMENTS.has(after.text)) out.push({ name: tree, op: after.text });
  });
  return out;
}

/** A write reads and writes a compound assignment; a plain `=` only writes. */
function factsOf(
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
