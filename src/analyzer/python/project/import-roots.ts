import { normalizePath } from '../../../path-utils.js';
import type { PackageNode } from '../../../types.js';
import { dirOf, joinRepoPath } from './paths.js';

/**
 * Where an import root came from. The order of the list is the precedence order, so the first
 * source that declares a directory is the one that is reported for it.
 */
export type ImportRootSource =
  'config' | 'manifest' | 'src-layout' | 'repository' | 'script-directory';

/** One directory that Python imports can be found under. Each root is a fact (V3 Phase 4.2). */
export interface ImportRoot {
  /** Repository-relative directory. `.` is the repository root. */
  readonly path: string;
  readonly source: ImportRootSource;
  /** The manifest that declared the root, for `manifest` roots */
  readonly manifest?: string;
}

/** A declared root that names no directory with files in the repository. */
export interface ImportRootProblem {
  readonly path: string;
  readonly message: string;
}

export interface ImportRootInput {
  /** `python.roots` from configuration, relative to the repository root */
  readonly configured: readonly string[];
  /** Package nodes from Phase 4.1. Only `python` lib packages contribute roots. */
  readonly packages: readonly PackageNode[];
  /** Every scanned repository-relative file path */
  readonly filePaths: readonly string[];
}

export interface ImportRootResolution {
  readonly roots: readonly ImportRoot[];
  readonly problems: readonly ImportRootProblem[];
}

/**
 * The import roots of a repository, in precedence order (V3 Phase 4.2):
 *
 * 1. Configured `python.roots`.
 * 2. Roots declared in Python package manifests.
 * 3. `src` when the repository has a Python file under `src/`.
 * 4. The repository root, always last.
 *
 * A configured or declared root that holds no scanned files is dropped and reported as a problem.
 * A directory that more than one source names keeps the highest-precedence source. The script
 * directory rule is per file, so it is exposed as `scriptDirectoryRoot` and applied at resolution.
 */
export function resolveImportRoots(input: ImportRootInput): ImportRootResolution {
  const files = input.filePaths.map(normalizePath);
  const roots: ImportRoot[] = [];
  const problems: ImportRootProblem[] = [];
  const seen = new Set<string>();

  const hasFilesUnder = (dir: string): boolean =>
    dir === '.' ? files.length > 0 : files.some((file) => file.startsWith(`${dir}/`));

  const addDeclared = (path: string, source: 'config' | 'manifest', manifest?: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    if (!hasFilesUnder(path)) {
      problems.push({
        path: manifest ?? path,
        message: `${source} import root "${path}" names no scanned files`,
      });
      return;
    }
    roots.push({ path, source, ...(manifest ? { manifest } : {}) });
  };

  for (const configured of input.configured) {
    addDeclared(joinRepoPath('.', configured), 'config');
  }

  const manifests = input.packages
    .filter((node) => node.ecosystem === 'python' && node.target === 'lib')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const node of manifests) {
    for (const root of [...node.roots].sort()) {
      addDeclared(normalizePath(root), 'manifest', node.manifest);
    }
  }

  const hasSrcPython = files.some((file) => file.startsWith('src/') && isPythonSource(file));
  if (hasSrcPython && !seen.has('src')) {
    seen.add('src');
    roots.push({ path: 'src', source: 'src-layout' });
  }

  if (!seen.has('.')) {
    seen.add('.');
    roots.push({ path: '.', source: 'repository' });
  }

  return { roots, problems };
}

/**
 * The root a script adds for itself: the directory it sits in, which is `sys.path[0]` when the
 * script runs. Imports from a script are resolved against this root first (V3 Phase 4.2, rule 5).
 */
export function scriptDirectoryRoot(scriptPath: string): ImportRoot {
  return { path: dirOf(normalizePath(scriptPath)), source: 'script-directory' };
}

function isPythonSource(file: string): boolean {
  return file.endsWith('.py') || file.endsWith('.pyi');
}
