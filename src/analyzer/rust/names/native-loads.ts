/**
 * Native library loads (V3 Phase 12.5). `libloading::Library::new(path)` loads a shared library at run
 * time. The library's code is not analyzed, so the load is recorded only as an observation, from the
 * function that makes it:
 *
 * Both forms are reported as `dynamic-module-specifier`, the reason for a module loaded from a value the
 * analyzer does not resolve. A literal path names a library, not a repository source file, and a computed
 * path is unknown; the detail text tells them apart.
 *
 * The call is read by its full path, `libloading::Library::new`, and only when no repository symbol
 * has that path. A `Library::new` reached through a `use libloading::Library` is not read yet.
 */
import type { UnresolvedReason } from '../../../types.js';
import { ownBodyFacts } from '../nested.js';
import type { Span } from '../items.js';
import { sourceSpanOf } from '../source-span.js';
import type { SourceSpan } from '../../../types.js';
import { isTokenGroup, type TokenTree } from '../token-tree.js';
import { buildRepo, contextOf, scopeCtx, symbolOf, type Ctx } from './calls.js';
import { splitArgs, textOf } from './callback-facts.js';
import type { RustCrateIndex } from './module-index.js';
import type { RustNameEnvironment } from './resolve.js';

/** One native library load, recorded where it is made. */
export interface NativeLoadObservation {
  /** The function that makes the load. */
  readonly from: string;
  readonly reason: UnresolvedReason;
  readonly subject: string;
  readonly detail: string;
  readonly location: SourceSpan;
}

const LIBRARY_NEW = 'libloading::Library::new';
/** A plain string literal with no escapes. */
const LITERAL = /^"([^"\\]*)"$/;

/** The native library loads of every function body in the crates. */
export function nativeLoadObservations(
  crates: readonly RustCrateIndex[],
  env: RustNameEnvironment,
): NativeLoadObservation[] {
  const repo = buildRepo(crates, env);
  const observations: NativeLoadObservation[] = [];
  for (const entry of repo.entries) {
    const body = entry.fn.item.body;
    if (body === null) continue;
    const file = entry.fn.owner.file;
    const ctx = contextOf(repo, entry);
    for (const fact of ownBodyFacts(body)) {
      if (fact.kind !== 'call' || !isLibraryNew(fact.path, ctx, fact.span, entry.fn.scopes)) {
        continue;
      }
      const first = splitArgs(fact.args)[0];
      if (first === undefined) continue;
      const location = sourceSpanOf(fact.span, file);
      const literal = literalPath(first);
      observations.push(
        literal !== undefined
          ? {
              from: entry.fn.id,
              reason: 'dynamic-module-specifier',
              subject: literal,
              detail: 'a native library is loaded at run time, and its code is not analyzed',
              location,
            }
          : {
              from: entry.fn.id,
              reason: 'dynamic-module-specifier',
              subject: `${LIBRARY_NEW}(${first.map(textOf).join('')})`,
              detail: 'the library path is not a string literal',
              location,
            },
      );
    }
  }
  return observations;
}

/** `libloading::Library::new`, when no repository symbol has that path. */
function isLibraryNew(
  path: readonly string[],
  ctx: Ctx,
  span: Span,
  scopes: Parameters<typeof scopeCtx>[1],
): boolean {
  if (path.join('::') !== LIBRARY_NEW) return false;
  const site = scopeCtx(ctx, scopes, span);
  return (
    symbolOf({ global: false, segments: path }, 'value', site.owner, site.crate, site.repo.env) ===
    undefined
  );
}

/** The value of an argument that is a single string literal, or undefined. */
function literalPath(tokens: readonly TokenTree[]): string | undefined {
  if (tokens.length !== 1) return undefined;
  const [token] = tokens;
  if (token === undefined || isTokenGroup(token) || token.kind !== 'str') return undefined;
  return LITERAL.exec(token.text)?.[1];
}
