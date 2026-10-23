/**
 * Compile-time includes (V3 Phase 10.4).
 *
 * - `include!("file")` pulls another source file into the crate. It gives an `imports` edge from the
 *   including file, with `loadKind: "include-macro"`.
 * - `include_str!` and `include_bytes!` embed a file. A template, stylesheet or schema gives a
 *   `usesResource` edge with `mechanism: "include"`. Any other file gives a `consumes` edge to an
 *   artifact, with `embed: true` and the artifact's format, or `unknown` when none is recognized.
 *
 * The path goes through the shared path evaluator (2.2). A plain string is relative to the file that
 * holds the macro. `concat!` may join strings and `env!("CARGO_MANIFEST_DIR")`, which is the package
 * anchor. Any other expression is a `dynamic-include-path` observation, and a path that names no
 * repository file is an `unresolved-module-path` observation.
 */
import * as nodePath from 'node:path';
import { detectArtifactFormat, detectResourceKind } from '../../../data/formats.js';
import { joinPathParts, resolveRepoPath, type PathPart } from '../../../facts/path-value.js';
import type { ArtifactFormat, ResourceKind, UnresolvedReason } from '../../../types.js';
import { scanFunctionBody, scanTokens } from '../body.js';
import type { Span } from '../items.js';
import { blocksOfTokens, factsOutside } from '../nested.js';
import { isTokenGroup, type TokenGroup, type TokenTree } from '../token-tree.js';
import type { RustCrateIndex, RustModuleNode } from './module-index.js';

/** A crate of the repository, with the directory of its package (where `Cargo.toml` sits). */
export interface IncludeCrate {
  readonly index: RustCrateIndex;
  /** The crate's target id, which a build-output dependency leaves from (10.5). */
  readonly packageId: string;
  /** Repository-relative directory of the package, `''` at the root, or undefined if unknown. */
  readonly packageDir: string | undefined;
}

export type IncludeEdge =
  | {
      /** An `include!` or `include_str!` of a file under `OUT_DIR`, written by the package's build script (10.5). */
      readonly kind: 'build-output';
      /** The package target that includes the file. */
      readonly from: string;
      readonly subject: string;
      readonly file: string;
      readonly span: Span;
    }
  | {
      readonly kind: 'imports';
      /** The including file. */
      readonly from: string;
      readonly to: string;
      readonly file: string;
      readonly span: Span;
    }
  | {
      readonly kind: 'uses';
      readonly from: string;
      readonly resourcePath: string;
      readonly resourceKind: ResourceKind;
      readonly file: string;
      readonly span: Span;
    }
  | {
      readonly kind: 'consumes';
      readonly from: string;
      readonly artifactPath: string;
      readonly format: ArtifactFormat;
      readonly file: string;
      readonly span: Span;
    }
  | {
      readonly kind: 'observation';
      readonly from: string;
      readonly attempted: 'imports' | 'consumes';
      readonly reason: UnresolvedReason;
      readonly subject: string;
      readonly detail: string;
      readonly file: string;
      readonly span: Span;
    };

const INCLUDE_MACROS: ReadonlySet<string> = new Set(['include', 'include_str', 'include_bytes']);

/** One macro invocation that may include a file. */
interface Site {
  /** The edge's source: the file for `include!`, otherwise the owning symbol. */
  readonly from: string;
  readonly file: string;
  readonly packageDir: string | undefined;
  readonly packageId: string;
  readonly name: string;
  readonly args: TokenGroup;
  readonly span: Span;
}

/** Finds every include in the repository and says what each one names. */
export function bindIncludes(
  crates: readonly IncludeCrate[],
  files: ReadonlySet<string>,
): IncludeEdge[] {
  const packageDirOf = new Map<string, string | undefined>();
  for (const crate of crates) {
    for (const node of moduleNodes(crate.index.root)) {
      if (!packageDirOf.has(node.file)) packageDirOf.set(node.file, crate.packageDir);
    }
  }

  const edges: IncludeEdge[] = [];
  const visit = (
    name: string,
    owner: string,
    file: string,
    args: TokenGroup,
    span: Span,
    packageId: string,
  ): void => {
    if (!INCLUDE_MACROS.has(name)) return;
    const from = name === 'include' ? file : owner;
    const edge = includeEdge(
      { from, file, packageDir: packageDirOf.get(file), packageId, name, args, span },
      files,
    );
    if (edge !== undefined) edges.push(edge);
  };

  for (const crate of crates) {
    for (const fn of crate.index.functions) {
      const body = fn.item.body;
      if (body === null) continue;
      for (const fact of scanFunctionBody(body)) {
        if (fact.kind === 'macro-call') {
          visit(lastOf(fact.path), fn.id, fn.owner.file, fact.args, fact.span, crate.packageId);
        }
      }
    }
    for (const decl of crate.index.decls) {
      const item = decl.item;
      if ((item.kind !== 'const' && item.kind !== 'static') || item.value === null) continue;
      const facts = factsOutside(scanTokens(item.value.tokens), blocksOfTokens(item.value.tokens));
      for (const fact of facts) {
        if (fact.kind === 'macro-call') {
          visit(lastOf(fact.path), decl.id, decl.owner.file, fact.args, fact.span, crate.packageId);
        }
      }
    }
    for (const call of crate.index.macroCalls) {
      visit(
        lastOf(call.path),
        call.owner.file,
        call.owner.file,
        call.args,
        call.span,
        crate.packageId,
      );
    }
  }
  return edges;
}

function includeEdge(site: Site, files: ReadonlySet<string>): IncludeEdge | undefined {
  const attempted = site.name === 'include' ? 'imports' : 'consumes';
  const parts = partsOf(site.args.children);
  if (parts === 'build-output') {
    return {
      kind: 'build-output',
      from: site.packageId,
      subject: `${site.name}!`,
      file: site.file,
      span: site.span,
    };
  }
  const value = parts === undefined ? undefined : joinPathParts(parts);
  if (value === undefined || value.kind === 'unknown') {
    return observation(
      site,
      attempted,
      'dynamic-include-path',
      `${site.name}! names a path that is not a literal`,
    );
  }

  const target = resolveRepoPath(value, {
    fileDir: directoryOf(site.file),
    ...(site.packageDir === undefined ? {} : { packageDir: site.packageDir }),
  });
  if (target === undefined || !files.has(target)) {
    return observation(
      site,
      attempted,
      'unresolved-module-path',
      `${site.name}! names no file in the repository`,
    );
  }

  if (site.name === 'include') {
    return { kind: 'imports', from: site.from, to: target, file: site.file, span: site.span };
  }
  const resourceKind = detectResourceKind(target);
  if (resourceKind !== undefined) {
    return {
      kind: 'uses',
      from: site.from,
      resourcePath: target,
      resourceKind,
      file: site.file,
      span: site.span,
    };
  }
  return {
    kind: 'consumes',
    from: site.from,
    artifactPath: target,
    format: detectArtifactFormat(target) ?? 'unknown',
    file: site.file,
    span: site.span,
  };
}

function observation(
  site: Site,
  attempted: 'imports' | 'consumes',
  reason: UnresolvedReason,
  detail: string,
): IncludeEdge {
  return {
    kind: 'observation',
    from: site.from,
    attempted,
    reason,
    subject: `${site.name}!`,
    detail,
    file: site.file,
    span: site.span,
  };
}

/**
 * The path parts of a macro's first argument, or undefined when it is not a literal or a
 * supported `concat!`. A plain string is relative to the file, so it starts with the file anchor.
 */
function partsOf(trees: readonly TokenTree[]): PathPart[] | 'build-output' | undefined {
  const [first = []] = splitAtCommas(trees);
  if (first.length === 1) {
    const literal = literalOf(first[0]);
    return literal === undefined
      ? undefined
      : [
          { kind: 'anchor', anchor: 'file-dir' },
          { kind: 'literal', text: literal },
        ];
  }
  const [head, bang, group] = first;
  if (
    first.length === 3 &&
    isWord(head, 'concat') &&
    isPunct(bang, '!') &&
    group !== undefined &&
    isTokenGroup(group)
  ) {
    return concatParts(group.children);
  }
  return undefined;
}

function concatParts(trees: readonly TokenTree[]): PathPart[] | 'build-output' | undefined {
  const parts: PathPart[] = [];
  for (const piece of splitAtCommas(trees)) {
    if (piece.length === 0) continue;
    const literal = piece.length === 1 ? literalOf(piece[0]) : undefined;
    if (literal !== undefined) {
      parts.push({ kind: 'literal', text: literal });
      continue;
    }
    const anchor = envAnchor(piece);
    if (anchor === 'out-dir') return 'build-output';
    if (anchor === undefined) return undefined;
    parts.push({ kind: 'anchor', anchor });
  }
  if (parts.length === 0) return undefined;
  if (parts[0]?.kind === 'literal') parts.unshift({ kind: 'anchor', anchor: 'file-dir' });
  return normalizeParts(parts);
}

/**
 * Merges adjacent literals, and drops a leading separator from a literal that follows an anchor, so
 * that `concat!(env!("CARGO_MANIFEST_DIR"), "/data/x.json")` is the directory plus `data/x.json`.
 */
function normalizeParts(parts: readonly PathPart[]): PathPart[] {
  const out: PathPart[] = [];
  for (const part of parts) {
    const previous = out[out.length - 1];
    if (part.kind === 'literal' && previous?.kind === 'literal') {
      out[out.length - 1] = { kind: 'literal', text: previous.text + part.text };
    } else if (part.kind === 'literal' && previous?.kind === 'anchor') {
      out.push({ kind: 'literal', text: part.text.replace(/^[/\\]+/, '') });
    } else {
      out.push(part);
    }
  }
  return out;
}

/**
 * `env!("CARGO_MANIFEST_DIR")` is the package anchor, and `env!("OUT_DIR")` is the build output
 * directory (10.5). Any other environment variable is unknown.
 */
function envAnchor(piece: readonly TokenTree[]): 'package-dir' | 'out-dir' | undefined {
  const [head, bang, group] = piece;
  if (
    piece.length !== 3 ||
    !isWord(head, 'env') ||
    !isPunct(bang, '!') ||
    group === undefined ||
    !isTokenGroup(group) ||
    group.children.length !== 1
  ) {
    return undefined;
  }
  const name = literalOf(group.children[0]);
  if (name === 'CARGO_MANIFEST_DIR') return 'package-dir';
  return name === 'OUT_DIR' ? 'out-dir' : undefined;
}

/** The value of a plain string literal without escapes or a prefix, or undefined. */
export function literalOf(tree: TokenTree | undefined): string | undefined {
  if (tree === undefined || isTokenGroup(tree) || tree.kind !== 'str') return undefined;
  const raw = /^r(#*)"([\s\S]*)"\1$/.exec(tree.text);
  if (raw !== null) return raw[2];
  if (tree.text.length < 2 || !tree.text.startsWith('"') || !tree.text.endsWith('"'))
    return undefined;
  const inner = tree.text.slice(1, -1);
  return inner.includes('\\') ? undefined : inner;
}

/** Splits token trees at top-level commas. Brackets are groups, so their commas stay inside. */
export function splitAtCommas(trees: readonly TokenTree[]): TokenTree[][] {
  const out: TokenTree[][] = [[]];
  for (const tree of trees) {
    if (isPunct(tree, ',')) out.push([]);
    else out[out.length - 1]?.push(tree);
  }
  return out;
}

export function isWord(tree: TokenTree | undefined, word: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'ident' && tree.value === word;
}

export function isPunct(tree: TokenTree | undefined, text: string): boolean {
  return tree !== undefined && !isTokenGroup(tree) && tree.kind === 'punct' && tree.text === text;
}

function lastOf(path: readonly string[]): string {
  return path[path.length - 1] ?? '';
}

function directoryOf(file: string): string {
  const dir = nodePath.posix.dirname(file);
  return dir === '.' ? '' : dir;
}

/** Every module node of a crate: the root, and each module it declares, at any depth. */
function moduleNodes(root: RustModuleNode): RustModuleNode[] {
  const out: RustModuleNode[] = [];
  const visit = (node: RustModuleNode): void => {
    out.push(node);
    for (const child of node.children.values()) visit(child);
  };
  visit(root);
  return out;
}
