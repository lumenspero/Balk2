import { discoverCargoPackages } from '../analyzer/rust/cargo/packages.js';
import type { CargoExtern } from '../analyzer/rust/cargo/dependencies.js';
import {
  discoverPythonPackages,
  type PythonPackageDiscovery,
} from '../analyzer/python/project/python-packages.js';
import type { PackageNode, RelationshipMetadata } from '../types.js';
import { discoverNpmPackages } from './npm-packages.js';

/** A `packageRoot` fact: a package and the file that is its entry point. */
export interface RepositoryPackageRoot {
  readonly packageId: string;
  readonly file: string;
}

/** A `dependsOn` edge between two packages, with `kind`, and `cfg` or `implicit` when they hold. */
export interface RepositoryDependency {
  readonly from: string;
  readonly to: string;
  readonly metadata: RelationshipMetadata;
}

export interface RepositoryPackageProblem {
  readonly path: string;
  readonly message: string;
}

/** The package facts of one repository, across npm, Python and Cargo (V3 Phase 7.5 wiring). */
export interface RepositoryPackages {
  readonly packages: readonly PackageNode[];
  readonly packageRoots: readonly RepositoryPackageRoot[];
  readonly dependencies: readonly RepositoryDependency[];
  /** Kept whole, because the Python front end resolves its entry points against its module index */
  readonly python: PythonPackageDiscovery;
  /**
   * Cargo dependencies that are not packages in the repository (registry, git, or a path outside
   * it). The Rust name resolver reads them, so `use serde::...` is external rather than unresolved.
   */
  readonly externs: readonly CargoExtern[];
  readonly problems: readonly RepositoryPackageProblem[];
}

/** The manifests any ecosystem reads. A manifest that cannot be read is reported, not parsed. */
const MANIFEST_NAMES = new Set([
  'cargo.toml',
  'package.json',
  'pyproject.toml',
  'setup.cfg',
  'setup.py',
]);

/** Dependency kinds, most production-relevant first. A pair keeps the first kind it declares. */
const KIND_ORDER = ['normal', 'build', 'peer', 'optional', 'dev'];

/**
 * Discovers the packages of every ecosystem in a repository. The result is the same for the same
 * files, whatever order they arrive in.
 *
 * A manifest that cannot be read is reported as a problem and left out of discovery, so it does not
 * also produce a misleading parse error.
 *
 * @param filePaths the repository files that passed the scan and the configured filters
 * @param readText reads a repository-relative file. It may throw when the file cannot be read.
 * @param exists whether a repository-relative path exists on disk, including unscanned files
 */
export function discoverRepositoryPackages(
  filePaths: readonly string[],
  readText: (path: string) => string,
  exists: (path: string) => boolean = () => false,
): RepositoryPackages {
  const texts = new Map<string, string>();
  const readProblems: RepositoryPackageProblem[] = [];
  for (const path of filePaths) {
    if (!MANIFEST_NAMES.has(basename(path).toLowerCase())) continue;
    try {
      texts.set(path, readText(path));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      readProblems.push({ path, message: `manifest cannot be read: ${reason}` });
    }
  }
  const readable = filePaths.filter((path) => !readProblems.some((p) => p.path === path));
  const read = (path: string): string => texts.get(path) ?? '';

  const cargo = discoverCargoPackages(readable, read);
  const npm = discoverNpmPackages(readable, read, exists);
  const python = discoverPythonPackages(readable, read);

  return {
    packages: [...cargo.packages, ...npm.packages, ...python.packages],
    packageRoots: [
      ...cargo.packageRoots,
      ...npm.packageRoots,
      ...pythonLibraryRoots(python.packages, readable),
    ],
    dependencies: mergeDependencies([
      ...cargo.dependencies.map((dependency) => ({
        from: dependency.from,
        to: dependency.to,
        metadata: {
          kind: dependency.kind,
          ...(dependency.cfg !== undefined ? { cfg: dependency.cfg } : {}),
          ...(dependency.implicit ? { implicit: true } : {}),
        },
      })),
      ...npm.dependencies.map((dependency) => ({
        from: dependency.from,
        to: dependency.to,
        metadata: { kind: dependency.kind },
      })),
      ...python.dependencies.map((dependency) => ({
        from: dependency.from,
        to: dependency.to,
        metadata: { kind: dependency.kind },
      })),
    ]),
    python,
    externs: cargo.externs,
    problems: [...readProblems, ...cargo.problems, ...npm.problems, ...python.problems],
  };
}

/**
 * One `dependsOn` edge per package pair, as the graph has one per (type, from, to). The pair keeps
 * the most production-relevant kind it declares. `cfg` and `implicit` are kept only when every
 * declaration of that kind agrees, the same rule the graph applies to merged relationships.
 */
function mergeDependencies(all: readonly RepositoryDependency[]): RepositoryDependency[] {
  const groups = new Map<string, RepositoryDependency[]>();
  for (const dependency of all) {
    const key = `${dependency.from}\0${dependency.to}`;
    groups.set(key, [...(groups.get(key) ?? []), dependency]);
  }

  return [...groups.values()].map((group) => {
    const rank = (dependency: RepositoryDependency): number => {
      const index = KIND_ORDER.indexOf(String(dependency.metadata.kind));
      return index === -1 ? KIND_ORDER.length : index;
    };
    const best = Math.min(...group.map(rank));
    const chosen = group.filter((dependency) => rank(dependency) === best);
    const first = chosen[0] ?? group[0];
    if (first === undefined) throw new Error('empty dependency group');

    const sameCfg = chosen.every((d) => d.metadata.cfg === first.metadata.cfg);
    const sameImplicit = chosen.every((d) => d.metadata.implicit === first.metadata.implicit);
    return {
      from: first.from,
      to: first.to,
      metadata: {
        kind: String(first.metadata.kind),
        ...(sameCfg && first.metadata.cfg !== undefined ? { cfg: first.metadata.cfg } : {}),
        ...(sameImplicit && first.metadata.implicit === true ? { implicit: true } : {}),
      },
    };
  });
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

const PYTHON_NON_PACKAGE_MODULES = new Set(['__init__', 'setup', 'conftest']);
const PYTHON_TEST_PACKAGES = new Set(['test', 'tests']);

/**
 * `packageRoot` edges for Python libraries (V3 Phase 4.1). Each top-level package's `__init__.py`,
 * and each top-level module, is an entry file of the library, in each import root. A library with no
 * declared root uses `src` when the repository has Python under it, and the repository root otherwise
 * (Phase 4.2). Test packages and `setup.py` are not entry files.
 */
function pythonLibraryRoots(
  packages: readonly PackageNode[],
  filePaths: readonly string[],
): RepositoryPackageRoot[] {
  const hasSrc = filePaths.some((file) => file.startsWith('src/') && file.endsWith('.py'));
  const out: RepositoryPackageRoot[] = [];
  for (const node of packages) {
    if (node.ecosystem !== 'python' || node.target !== 'lib') continue;
    const roots = node.roots.length > 0 ? node.roots : [hasSrc ? 'src' : '.'];
    for (const root of roots) {
      const prefix = root === '.' ? '' : `${root}/`;
      for (const file of filePaths) {
        if (!file.startsWith(prefix) || !file.endsWith('.py')) continue;
        const rest = file.slice(prefix.length);
        const initMatch = /^([^/]+)\/__init__\.py$/.exec(rest);
        const moduleMatch = /^([^/]+)\.py$/.exec(rest);
        const name = initMatch?.[1] ?? moduleMatch?.[1];
        if (name === undefined) continue;
        if (initMatch === null && PYTHON_NON_PACKAGE_MODULES.has(name)) continue;
        if (initMatch !== null && PYTHON_TEST_PACKAGES.has(name)) continue;
        out.push({ packageId: node.id, file });
      }
    }
  }
  return out.sort((a, b) =>
    a.packageId + a.file < b.packageId + b.file
      ? -1
      : a.packageId + a.file > b.packageId + b.file
        ? 1
        : 0,
  );
}
