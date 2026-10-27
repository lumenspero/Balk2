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

/** A base a bare relative path can be taken against (Phase 11.4). */
export type PathBase = 'file' | 'package' | 'repository' | 'public';

/**
 * The bases for one bare relative path. `order` is most specific first, and always ends with the
 * repository root. `dirs` gives the directory of each base the file has, so a base the file does not
 * have (no package, for example) is skipped.
 */
export interface BareBases {
  readonly order: readonly PathBase[];
  readonly dirs: Readonly<Partial<Record<PathBase, string>>>;
}

/**
 * The default base order by language (Phase 11.4). Python and JavaScript/TypeScript check the
 * directory of the script or module first; Cargo checks the package directory first. Each then
 * checks the repository root. An `override` (from `data.pathBase`) replaces the order for the
 * language, and the repository root always comes last.
 */
export function defaultBareBases(
  language: 'javascript' | 'typescript' | 'python' | 'rust',
  dirs: { readonly file: string; readonly package?: string },
  override?: readonly PathBase[],
): BareBases {
  const chosen: readonly PathBase[] =
    override ?? (language === 'rust' ? ['package', 'repository'] : ['file', 'repository']);
  const order: readonly PathBase[] = [
    ...chosen.filter((base) => base !== 'repository'),
    'repository',
  ];
  return { order, dirs: { file: dirs.file, package: dirs.package } };
}

/**
 * The repository-relative path a bare relative path names (Phase 11.4). Each base gives one
 * candidate, in order, with duplicates removed. A single existing candidate is used. When several
 * exist, the first one (the most specific base) is used. When none exists, the path is taken at
 * the repository root, as a path with no known file has always been. Returns undefined when no
 * candidate stays inside the repository.
 */
/**
 * The repository paths a bare relative path can name under these bases, most specific first, with
 * duplicates removed. Empty when no base stays inside the repository.
 */
export function bareCandidates(path: string, bases: BareBases): string[] {
  const candidates: string[] = [];
  for (const base of bases.order) {
    const dir = base === 'repository' ? '' : bases.dirs[base];
    if (dir === undefined) continue;
    const joined = nodePath.posix.normalize(nodePath.posix.join(dir, path));
    if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) continue;
    const repoPath = joined === '.' ? '' : joined;
    if (!candidates.includes(repoPath)) candidates.push(repoPath);
  }
  return candidates;
}

/** True when one of the path's candidates is a scanned repository file (Phase 11.6). */
export function hasBareCandidate(
  path: string,
  bases: BareBases,
  exists: (repoPath: string) => boolean,
): boolean {
  return !path.startsWith('/') && bareCandidates(path, bases).some((c) => exists(c));
}

/**
 * The repository-relative path a bare relative path names (Phase 11.4). Each base gives one
 * candidate, in order, with duplicates removed. A single existing candidate is used. When several
 * exist, the first one (the most specific base) is used. When none exists, the path is taken at
 * the repository root, as a path with no known file has always been. Returns undefined when no
 * candidate stays inside the repository.
 */
export function resolveBarePath(
  path: string,
  bases: BareBases,
  exists: (repoPath: string) => boolean,
): string | undefined {
  if (path.startsWith('/')) return undefined;

  const candidates = bareCandidates(path, bases);
  if (candidates.length === 0) return undefined;
  const existing = candidates.filter((candidate) => exists(candidate));
  if (existing.length === 1) return existing[0];
  if (existing.length > 1) return candidates[0];
  const atRoot = nodePath.posix.normalize(path);
  // A path that climbs out of the root can still name a file through the file directory, such as
  // `../package.json` from `src/`. Use that candidate instead of the raw path.
  if (atRoot === '..' || atRoot.startsWith('../')) return candidates[0];
  return atRoot;
}

/** The bases a served URL path is placed from: the public folder, the package root, the repo root. */
export function servedBareBases(dirs: { readonly package?: string }): BareBases {
  const pkg = dirs.package;
  return {
    order: ['public', 'package', 'repository'],
    dirs: {
      public: pkg === undefined ? undefined : pkg === '' ? 'public' : `${pkg}/public`,
      package: pkg,
    },
  };
}
