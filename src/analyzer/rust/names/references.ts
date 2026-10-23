/**
 * References (V3 Phase 9.7). A `references` edge goes from the symbol that mentions a name to the
 * symbol the name resolves to. Mentions counted:
 *
 * - types in function signatures and in `let` annotations, with the function as the owner;
 * - fields of structs, unions and enums, and of enum variants (owned by the variant, `Enum.Variant`);
 * - a type alias's type, and a const's or static's type and value (owned by the const or static);
 * - generic bounds of functions and of type declarations (a bound names its trait);
 * - struct literals, enum variant paths, and tuple-struct constructors (which name the struct).
 *
 * Generic parameters are not references. A path that looks internal and does not resolve is
 * reported as an observation. Known gaps: a nested function's mentions are credited to the
 * enclosing function; `impl` headers are not mentions; macro arguments are not scanned.
 */
import { type BodyFact, scanTokens } from '../body.js';
import { ownBodyFacts } from '../nested.js';
import type { GenericParam, Span } from '../items.js';
import { isTokenGroup, type TokenTree } from '../token-tree.js';
import { buildRepo, type Ctx, contextOf, fillBounds, localsOf, type Repo } from './calls.js';
import type { RustCrateIndex } from './module-index.js';
import {
  type RustNameEnvironment,
  type RustPath,
  resolveName,
  type UnresolvedReason,
} from './resolve.js';
import { readPath } from './type-paths.js';

export interface ReferenceEdge {
  readonly from: string;
  readonly to: string;
  /** The file of the mentioning symbol. */
  readonly file: string;
  /** One span per mention, in source order. */
  readonly spans: readonly Span[];
}

export interface ReferenceUnresolved {
  readonly file: string;
  readonly span: Span;
  readonly subject: string;
  readonly reason: UnresolvedReason;
  readonly detail: string;
}

export interface ReferenceResults {
  readonly edges: readonly ReferenceEdge[];
  readonly unresolved: readonly ReferenceUnresolved[];
}

interface MutableEdge {
  readonly from: string;
  readonly to: string;
  readonly file: string;
  readonly spans: Span[];
}

/** The ids a mention may name, by the position it is in. */
interface Targets {
  /** Type-position names: types and traits. */
  readonly types: ReadonlySet<string>;
  /** Value-position names: consts, statics, variants, and tuple or unit structs. */
  readonly values: ReadonlySet<string>;
  /** Struct-literal names: types and variants. */
  readonly literals: ReadonlySet<string>;
}

interface Walk {
  readonly repo: Repo;
  readonly targets: Targets;
  readonly edges: Map<string, MutableEdge>;
  readonly unresolved: ReferenceUnresolved[];
}

/** Who is mentioning: the symbol that owns the mention, its file, and the generic names in scope. */
interface Source {
  readonly ctx: Ctx;
  readonly owner: string;
  readonly file: string;
  readonly generics: ReadonlySet<string>;
}

const TYPE_KEYWORDS: ReadonlySet<string> = new Set([
  'dyn',
  'impl',
  'mut',
  'const',
  'fn',
  'for',
  'where',
  'unsafe',
  'extern',
  'as',
  'ref',
]);

/** Binds the `references` edges of every symbol in the repository. Crates are indexed first. */
export function bindReferences(
  crates: readonly RustCrateIndex[],
  env: RustNameEnvironment,
): ReferenceResults {
  const repo = buildRepo(crates, env);
  const types = new Set<string>(repo.traitIds);
  const values = new Set<string>();
  const variants = new Set<string>();
  for (const crate of crates) {
    for (const decl of crate.decls) {
      if (decl.item.kind === 'const' || decl.item.kind === 'static') {
        values.add(decl.id);
        continue;
      }
      types.add(decl.id);
      if (decl.item.kind === 'enum') {
        for (const variant of decl.item.variants) variants.add(`${decl.id}.${variant.name}`);
      }
    }
  }
  const targets: Targets = {
    types,
    values: new Set([...values, ...variants, ...types]),
    literals: new Set([...types, ...variants]),
  };
  const walk: Walk = { repo, targets, edges: new Map(), unresolved: [] };

  for (const entry of repo.entries) {
    const fn = entry.fn;
    const ctx = contextOf(repo, entry);
    const container = fn.container;
    const generics = namesOf([
      ...fn.item.generics,
      ...(container?.kind === 'impl' || container?.kind === 'trait' ? container.generics : []),
    ]);
    const src: Source = { ctx, owner: fn.id, file: fn.owner.file, generics };
    const span = fn.item.span;
    for (const param of fn.item.params) {
      if (param.kind === 'typed') mentionsIn(walk, src, param.type.tokens, span);
    }
    if (fn.item.ret !== null) mentionsIn(walk, src, fn.item.ret.tokens, span);
    for (const to of boundTargets(ctx)) mention(walk, src, to, span);
    const body = fn.item.body;
    if (body !== null) {
      const facts = ownBodyFacts(body);
      factMentions(walk, src, facts, localsOf(fn.item, facts, ctx));
    }
  }

  for (const crate of crates) {
    for (const decl of crate.decls) {
      const item = decl.item;
      const file = decl.owner.file;
      const ctx: Ctx = { repo, crate, owner: decl.owner, self: null, bounds: new Map() };
      if (item.kind === 'struct' || item.kind === 'union' || item.kind === 'enum') {
        const src: Source = { ctx, owner: decl.id, file, generics: namesOf(item.generics) };
        fillBounds(ctx, item.generics, item.where);
        for (const to of boundTargets(ctx)) mention(walk, src, to, item.span);
        if (item.kind === 'enum') {
          for (const variant of item.variants) {
            const variantSrc: Source = { ...src, owner: `${decl.id}.${variant.name}` };
            for (const field of variant.fields)
              mentionsIn(walk, variantSrc, field.type.tokens, item.span);
          }
        } else {
          for (const field of item.fields) mentionsIn(walk, src, field.type.tokens, item.span);
        }
      } else if (item.kind === 'type') {
        const src: Source = { ctx, owner: decl.id, file, generics: new Set() };
        if (item.ty !== null) mentionsIn(walk, src, item.ty.tokens, item.span);
      } else if (item.kind === 'const' || item.kind === 'static') {
        const src: Source = { ctx, owner: decl.id, file, generics: new Set() };
        if (item.ty !== null) mentionsIn(walk, src, item.ty.tokens, item.span);
        if (item.value !== null) {
          const facts = scanTokens(item.value.tokens);
          factMentions(walk, src, facts, new Map());
        }
      }
    }
  }

  return {
    edges: [...walk.edges.values()],
    unresolved: walk.unresolved,
  };
}

function namesOf(generics: readonly GenericParam[]): ReadonlySet<string> {
  return new Set(generics.filter((g) => g.kind !== 'lifetime').map((g) => g.name));
}

/** The trait ids a context's generic names are bound by. */
function boundTargets(ctx: Ctx): string[] {
  return [...ctx.bounds.values()].flat();
}

/** Records one mention, merging mentions of the same target by the same owner. */
function mention(walk: Walk, src: Source, to: string, span: Span): void {
  const key = `${src.owner}\u0000${to}`;
  const existing = walk.edges.get(key);
  if (existing !== undefined) {
    existing.spans.push(span);
    return;
  }
  walk.edges.set(key, { from: src.owner, to, file: src.file, spans: [span] });
}

/** The types named by a token list: every path in it, including those inside generic arguments. */
function mentionsIn(walk: Walk, src: Source, trees: readonly TokenTree[], span: Span): void {
  for (let i = 0; i < trees.length; i += 1) {
    const tree = trees[i];
    if (tree === undefined) break;
    if (isTokenGroup(tree)) {
      mentionsIn(walk, src, tree.children, span);
      continue;
    }
    if (tree.kind !== 'ident' || TYPE_KEYWORDS.has(tree.value)) continue;
    const { path, end } = readPath(trees.slice(i));
    if (path === null) continue;
    i += Math.max(end, 1) - 1;
    mentionPath(walk, src, path, 'type', walk.targets.types, span);
  }
}

/** The mentions in a body's facts: struct literals, paths, calls that name a struct or variant, and `let` types. */
function factMentions(
  walk: Walk,
  src: Source,
  facts: readonly BodyFact[],
  locals: ReadonlyMap<string, unknown>,
): void {
  for (const fact of facts) {
    if (fact.kind === 'let') {
      if (fact.type !== null) mentionsIn(walk, src, fact.type.tokens, fact.span);
    } else if (fact.kind === 'call' || fact.kind === 'path') {
      const segments = fact.kind === 'call' ? fact.path : fact.segments;
      if (segments.length === 1 && locals.has(segments[0] ?? '')) continue;
      const path: RustPath = { global: false, segments };
      mentionPath(walk, src, path, 'value', walk.targets.values, fact.span);
    } else if (fact.kind === 'struct-literal') {
      const path: RustPath = { global: false, segments: fact.path };
      mentionPath(walk, src, path, 'type', walk.targets.literals, fact.span);
    }
  }
}

/** Records a mention of a path when it names an accepted id, and reports it when it is unresolved. */
function mentionPath(
  walk: Walk,
  src: Source,
  path: RustPath,
  ns: 'type' | 'value',
  accept: ReadonlySet<string>,
  span: Span,
): void {
  const [first] = path.segments;
  if (ns === 'type' && path.segments.length === 1 && src.generics.has(first ?? '')) return;
  const result = resolveIn(walk, src, path, ns, accept);
  if (result.to !== null) {
    mention(walk, src, result.to, span);
  } else if (result.unresolved !== null) {
    walk.unresolved.push({
      file: src.file,
      span,
      subject: path.segments.join('::'),
      reason: result.unresolved.reason,
      detail: result.unresolved.detail,
    });
  }
}

interface Resolved {
  readonly to: string | null;
  readonly unresolved: { readonly reason: UnresolvedReason; readonly detail: string } | null;
}

/**
 * The accepted id a path names. `Self` is the impl's type; `Self::V` and `Type::V` name a variant
 * when the enum has one; anything else resolves through the scopes.
 */
function resolveIn(
  walk: Walk,
  src: Source,
  path: RustPath,
  ns: 'type' | 'value',
  accept: ReadonlySet<string>,
): Resolved {
  const none: Resolved = { to: null, unresolved: null };
  const { segments } = path;
  if (!path.global && segments[0] === 'Self') {
    const self = src.ctx.self;
    if (self === null || self.kind !== 'type') return none;
    if (segments.length === 1)
      return accept.has(self.id) ? { to: self.id, unresolved: null } : none;
    const variant = `${self.id}.${segments[1] ?? ''}`;
    return segments.length === 2 && accept.has(variant) ? { to: variant, unresolved: null } : none;
  }
  const resolution = resolveName(path, ns, src.ctx.owner, src.ctx.crate, walk.repo.env);
  switch (resolution.kind) {
    case 'symbol':
      return accept.has(resolution.id) ? { to: resolution.id, unresolved: null } : none;
    case 'associated': {
      if (resolution.rest.length !== 1) return none;
      const variant = `${resolution.id}.${resolution.rest[0] ?? ''}`;
      return accept.has(variant) ? { to: variant, unresolved: null } : none;
    }
    case 'unresolved':
      return {
        to: null,
        unresolved: { reason: resolution.reason, detail: resolution.detail },
      };
    default:
      return none;
  }
}
