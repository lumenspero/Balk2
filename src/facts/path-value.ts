import * as nodePath from 'node:path';
import { isDataArtifact } from '../data/formats.js';
import type { PathAnchor } from './types.js';

/**
 * The shared path evaluator (Phase 2.2). Every language reduces its path expressions to these
 * parts; the evaluator joins them and resolves anchors the same way for every language. Each front
 * end decides only how its syntax maps to parts.
 */

/** One piece of a path expression, after a front end has read its syntax. */
export type PathPart =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'anchor'; readonly anchor: PathAnchor }
  | { readonly kind: 'unknown' };

/** The value of a path expression: known with its anchor, or not statically known. */
export type PathValue =
  | { readonly kind: 'known'; readonly anchor: PathAnchor; readonly path: string }
  | { readonly kind: 'unknown' };

/** Where anchors point, for resolving a path value to a repository-relative path. */
export interface PathContext {
  /** Repository-relative directory of the file that contains the expression ('' at the root). */
  readonly fileDir: string;
  /** Repository-relative directory of the owning package, when there is one. */
  readonly packageDir?: string;
}

/**
 * Joins path parts into one value. The first part may be an anchor, or a literal that makes the
 * path relative to the working directory. Any unknown part makes the whole value unknown, and an
 * anchor after the first part is not a join the evaluator can model.
 */
export function joinPathParts(parts: readonly PathPart[]): PathValue {
  if (parts.length === 0 || parts.some((part) => part.kind === 'unknown')) {
    return { kind: 'unknown' };
  }
  const [head, ...rest] = parts;
  if (rest.some((part) => part.kind === 'anchor')) return { kind: 'unknown' };

  const literals = (head?.kind === 'literal' ? [head, ...rest] : rest).map((part) =>
    part.kind === 'literal' ? part.text : '',
  );
  const anchor: PathAnchor = head?.kind === 'anchor' ? head.anchor : 'cwd';
  const path = literals.length === 0 ? '' : nodePath.posix.join(...literals);
  return { kind: 'known', anchor, path: path === '' ? '.' : path };
}

/**
 * The repository-relative path a value names, or `undefined` when it names nothing inside the
 * repository: an absolute path, a path that climbs out of the root, or a package anchor with no
 * package.
 */
export function resolveRepoPath(value: PathValue, context: PathContext): string | undefined {
  if (value.kind === 'unknown') return undefined;
  if (value.path.startsWith('/')) return undefined;

  let base: string;
  if (value.anchor === 'file-dir') {
    base = context.fileDir;
  } else if (value.anchor === 'package-dir') {
    if (context.packageDir === undefined) return undefined;
    base = context.packageDir;
  } else {
    base = '';
  }

  const joined = nodePath.posix.normalize(nodePath.posix.join(base, value.path));
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return undefined;
  return joined === '.' ? '' : joined;
}

/**
 * A string that names a file in the repository: no whitespace, a basename before the extension (so
 * `.json` alone does not count), a recognized data extension, and not a URL, a web-root path or a
 * template with a placeholder. These filters apply to every language.
 */
export function isDataPathLiteral(text: string): boolean {
  if (/\s/.test(text) || isRemoteOrTemplate(text)) return false;
  return /[^./\\]\.[A-Za-z0-9]+$/.test(text) && isDataArtifact(text);
}

/**
 * A URL, a web-root path such as `/manifest.json` (served by the app, not read from the repo), or a
 * template such as `steamspy_page_{page}.json` (a name that varies at run time).
 */
function isRemoteOrTemplate(text: string): boolean {
  return text.includes('://') || text.startsWith('/') || /[{}]/.test(text);
}
