/**
 * Rust callbacks (V3 Phase 12.4). A function passed to a standard-library call, or to an iterator or
 * combinator method, is a callback: `thread::spawn(worker)` and `items.map(parse)` link the caller
 * to `worker` and `parse`. The callback engine turns each into `passesCallback`, as it does for JS/TS.
 *
 * - `thread::spawn(f)` and `std::thread::spawn(f)` are read when no repository symbol has that path,
 *   so a repository `thread` module is not mistaken for the standard library.
 * - `map`, `filter`, `for_each`, `filter_map` and `flat_map` are read by method name, whatever the
 *   receiver is: the receiver's type is not known, so the policy is by name.
 *
 * The callback is a path that resolves to a repository function, which is a symbol; a closure is
 * inline, as in JS/TS; anything else is an unresolved observation. A `use` of `thread` is not
 * checked, and a method on a receiver is not matched by its receiver's type.
 */
import type { CallbackCatalogEntry } from '../../../facts/callback-engine.js';
import type { ArgValue, CallSite, CallbackResolution, FileFacts } from '../../../facts/types.js';
import { ownBodyFacts } from '../nested.js';
import { sourceSpanOf } from '../source-span.js';
import { isTokenGroup, type TokenGroup, type TokenTree } from '../token-tree.js';
import { buildRepo, contextOf, scopeCtx, symbolOf, type Ctx } from './calls.js';
import type { RustCrateIndex } from './module-index.js';
import type { RustNameEnvironment } from './resolve.js';
import { readPath } from './type-paths.js';

/** Iterator and combinator methods that call the function they are given. */
const CALLBACK_METHODS: readonly string[] = ['map', 'filter', 'for_each', 'filter_map', 'flat_map'];

/** The catalog the callback engine reads for the Rust sinks. */
export const RUST_CALLBACK_CATALOG: readonly CallbackCatalogEntry[] = [
  { function: 'spawn', callbackArg: 0, languages: ['rust'] },
  ...CALLBACK_METHODS.map((method): CallbackCatalogEntry => ({
    function: method,
    callbackArg: 0,
    languages: ['rust'],
  })),
];

/** The callback facts of every function body, one call fact for each sink call that has a callback. */
export function rustCallbackFacts(
  crates: readonly RustCrateIndex[],
  env: RustNameEnvironment,
): CallSite[] {
  const repo = buildRepo(crates, env);
  const functions = new Set(crates.flatMap((crate) => crate.functions.map((fn) => fn.id)));
  const facts: CallSite[] = [];
  for (const entry of repo.entries) {
    const body = entry.fn.item.body;
    if (body === null) continue;
    const file = entry.fn.owner.file;
    const ctx = contextOf(repo, entry);
    for (const fact of ownBodyFacts(body)) {
      let name: string | undefined;
      let args: TokenGroup | undefined;
      if (fact.kind === 'call' && isStdSpawn(fact.path, ctx, fact.span, entry.fn.scopes)) {
        name = 'spawn';
        args = fact.args;
      } else if (fact.kind === 'method-call' && CALLBACK_METHODS.includes(fact.method)) {
        name = fact.method;
        args = fact.args;
      }
      if (name === undefined || args === undefined) continue;

      const first = splitArgs(args)[0];
      if (first === undefined) continue;
      const site = scopeCtx(ctx, entry.fn.scopes, fact.span);
      const callback: ArgValue = {
        kind: 'callback',
        span: sourceSpanOf(fact.span, file),
        resolution: resolutionOf(first, site, functions),
      };
      facts.push({
        kind: 'call',
        filePath: file,
        span: sourceSpanOf(fact.span, file),
        owner: entry.fn.id,
        name,
        positional: [callback],
        keyword: {},
      });
    }
  }
  return facts;
}

/** The callback facts grouped by file, in the form the callback engine reads. */
export function rustCallbackFiles(facts: readonly CallSite[]): FileFacts[] {
  const byFile = new Map<string, CallSite[]>();
  for (const fact of facts) {
    byFile.set(fact.filePath, [...(byFile.get(fact.filePath) ?? []), fact]);
  }
  return [...byFile].map(([filePath, list]) => ({ filePath, language: 'rust', facts: list }));
}

/** `thread::spawn` or `std::thread::spawn`, when no repository symbol has that path. */
function isStdSpawn(
  path: readonly string[],
  ctx: Ctx,
  span: {
    readonly line: number;
    readonly column: number;
    readonly endLine: number;
    readonly endColumn: number;
  },
  scopes: Parameters<typeof scopeCtx>[1],
): boolean {
  const segments = path.join('::');
  if (segments !== 'thread::spawn' && segments !== 'std::thread::spawn') return false;
  const site = scopeCtx(ctx, scopes, span);
  return (
    symbolOf({ global: false, segments: path }, 'value', site.owner, site.crate, site.repo.env) ===
    undefined
  );
}

/** What one argument refers to: a closure is inline, a repository function a symbol, else unresolved. */
function resolutionOf(
  tokens: readonly TokenTree[],
  site: Ctx,
  functions: ReadonlySet<string>,
): CallbackResolution {
  const [first] = tokens;
  if (first !== undefined && !isTokenGroup(first)) {
    if (first.kind === 'punct' && first.text.startsWith('|')) return { kind: 'inline' };
    if (first.kind === 'ident' && first.value === 'move') return { kind: 'inline' };
  }
  const read = readPath(tokens);
  if (read.path !== null && read.end === tokens.length) {
    const found = symbolOf(read.path, 'value', site.owner, site.crate, site.repo.env);
    if (found !== undefined && functions.has(found)) return { kind: 'symbol', id: found };
  }
  return { kind: 'unresolved', subject: tokens.map(textOf).join('') || 'callback' };
}

export function textOf(tree: TokenTree): string {
  return isTokenGroup(tree) ? `${tree.open.text}${tree.close?.text ?? ''}` : tree.text;
}

/** The comma-separated argument token lists of a call. */
export function splitArgs(group: TokenGroup): TokenTree[][] {
  const args: TokenTree[][] = [];
  let current: TokenTree[] = [];
  for (const child of group.children) {
    if (!isTokenGroup(child) && child.kind === 'punct' && child.text === ',') {
      if (current.length > 0) args.push(current);
      current = [];
    } else {
      current.push(child);
    }
  }
  if (current.length > 0) args.push(current);
  return args;
}
