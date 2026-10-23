/**
 * Binds the `use` declarations of one Rust crate (V3 Phase 9.3).
 *
 * Each `use` entry resolves in every namespace where its path names something. The name it binds
 * is recorded in its module, so later paths find it (resolve.ts). A `use` can name something that
 * another `use` brings in, so bindings are made in rounds until none is new. Each file that a
 * `use` reaches gets one `imports` edge. A `use` that cannot be resolved is reported, unless it
 * names an extern crate or a standard crate, which is outside the repository.
 *
 * Edition 2015 resolves a `use` path from the crate root, unless it starts with `self`, `super` or
 * `crate`. Edition 2018 and later use the uniform rule (resolve.ts).
 */
import type { Span } from '../items.js';
import type { PendingUse, RustCrateIndex, ImportBinding, RustModuleNode } from './module-index.js';
import type { RustNamespace } from './namespaces.js';
import {
  resolveName,
  type Resolution,
  type RustNameEnvironment,
  type UnresolvedReason,
} from './resolve.js';

/** A `use` that reaches a repository file. `target` is the file the name or module lives in. */
export interface ImportEdge {
  readonly file: string;
  readonly target: string;
  readonly span: Span;
  readonly glob: boolean;
}

/** A `use` that could not be resolved. */
export interface UnresolvedUse {
  readonly file: string;
  readonly span: Span;
  readonly subject: string;
  readonly reason: UnresolvedReason;
  readonly detail: string;
}

export interface ImportResult {
  readonly edges: readonly ImportEdge[];
  readonly unresolved: readonly UnresolvedUse[];
}

const NAMESPACES: readonly RustNamespace[] = ['type', 'value', 'macro'];
/** A fixed point is reached in far fewer rounds than this on real code. The cap guards against cycles. */
const MAX_ROUNDS = 64;

interface Attempt {
  readonly bound: boolean;
  /** The repository file the bound name lives in, or null for an extern or associated target. */
  readonly target: string | null;
  /** The last thing the path resolved to, for the report when it stays unbound. */
  readonly last: Resolution;
}

/** Binds every `use` in the crate. Mutates the crate's module nodes; call it once per crate. */
export function bindImports(crate: RustCrateIndex, env: RustNameEnvironment): ImportResult {
  const uses: readonly PendingUse[] = crate.uses;
  const attempts: (Attempt | undefined)[] = uses.map(() => undefined);
  const lasts: Resolution[] = uses.map(() => ({ kind: 'not-found' }));

  for (let round = 0; round < MAX_ROUNDS; round++) {
    let progress = false;
    uses.forEach((use, i) => {
      if (attempts[i]?.bound) return;
      const attempt = tryBind(use, crate, env);
      lasts[i] = attempt.last;
      if (attempt.bound) {
        attempts[i] = attempt;
        progress = true;
      }
    });
    if (!progress) break;
  }

  const edges: ImportEdge[] = [];
  const unresolved: UnresolvedUse[] = [];
  uses.forEach((use, i) => {
    const attempt = attempts[i];
    const file = use.owner.file;
    if (attempt?.bound) {
      if (attempt.target !== null) {
        edges.push({ file, target: attempt.target, span: use.entry.span, glob: use.entry.glob });
      }
      return;
    }
    const subject = use.entry.path.join('::');
    const last = lasts[i] ?? { kind: 'not-found' };
    if (last.kind === 'unresolved') {
      unresolved.push({
        file,
        span: use.entry.span,
        subject,
        reason: last.reason,
        detail: last.detail,
      });
    } else {
      unresolved.push({
        file,
        span: use.entry.span,
        subject,
        reason: 'unresolved-module-path',
        detail: 'no item, crate, or standard crate has this path',
      });
    }
  });
  return { edges, unresolved };
}

/** Resolves one `use` and binds what it names. Returns whether anything was bound. */
function tryBind(use: PendingUse, crate: RustCrateIndex, env: RustNameEnvironment): Attempt {
  const { owner, entry } = use;
  const [first] = entry.path;
  const from =
    crate.edition === '2015' && first !== undefined && !['self', 'super', 'crate'].includes(first)
      ? crate.root
      : owner;
  const path = { global: entry.global, segments: entry.path };

  if (entry.glob) {
    const resolution = resolveName(path, 'type', from, crate, env);
    if (resolution.kind === 'module') {
      if (!owner.globs.some((glob) => glob.source === resolution.node)) {
        owner.globs.push({ source: resolution.node, isPub: use.isPub });
      }
      return { bound: true, target: resolution.node.file, last: resolution };
    }
    if (resolution.kind === 'extern' || resolution.kind === 'associated') {
      // An extern or enum glob names nothing this pass can enumerate, so it adds no source.
      owner.globs.push({ source: null, isPub: use.isPub });
      return { bound: true, target: null, last: resolution };
    }
    return { bound: false, target: null, last: resolution };
  }

  let bound = false;
  let target: string | null = null;
  let last: Resolution = { kind: 'not-found' };
  for (const ns of NAMESPACES) {
    const resolution = resolveName(path, ns, from, crate, env);
    if (resolution.kind === 'not-found' || resolution.kind === 'unresolved') {
      if (resolution.kind === 'unresolved' || last.kind === 'not-found') last = resolution;
      continue;
    }
    last = resolution;
    const binding = toBinding(resolution, use.isPub);
    if (entry.bind !== null && !ownsName(owner, entry.bind, ns)) {
      setImport(owner, ns, entry.bind, binding);
    }
    target = target ?? targetFile(resolution);
    bound = true;
  }
  return { bound, target, last };
}

function toBinding(resolution: Resolution, isPub: boolean): ImportBinding {
  switch (resolution.kind) {
    case 'symbol':
      return { kind: 'symbol', id: resolution.id, isPub };
    case 'module':
      return { kind: 'module', node: resolution.node, id: resolution.id, isPub };
    case 'extern':
      return { kind: 'extern', crate: resolution.crate, isPub };
    case 'associated':
      return { kind: 'associated', id: resolution.id, rest: resolution.rest, isPub };
    default:
      throw new Error(`toBinding: ${resolution.kind} binds nothing`);
  }
}

/** The repository file a resolved name lives in. */
function targetFile(resolution: Resolution): string | null {
  switch (resolution.kind) {
    case 'symbol':
    case 'associated':
      return resolution.id.slice(0, resolution.id.indexOf(':'));
    case 'module':
      return resolution.node.file;
    default:
      return null;
  }
}

/** Whether a module already has the name in this namespace, as an item or a `use`. Items win. */
function ownsName(owner: RustModuleNode, name: string, ns: RustNamespace): boolean {
  if (owner.tables.get(owner.scope)?.[ns].has(name)) return true;
  if (ns === 'type' && owner.children.has(name)) return true;
  return owner.imports.get(ns)?.has(name) ?? false;
}

function setImport(
  owner: RustModuleNode,
  ns: RustNamespace,
  name: string,
  binding: ImportBinding,
): void {
  let table = owner.imports.get(ns);
  if (table === undefined) {
    table = new Map();
    owner.imports.set(ns, table);
  }
  table.set(name, binding);
}
