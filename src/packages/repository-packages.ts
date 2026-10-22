import { discoverCargoPackages } from '../analyzer/rust/cargo/packages.js';
import {
  discoverPythonPackages,
  type PythonPackageDiscovery,
} from '../analyzer/python/project/python-packages.js';
import type { PackageNode, RelationshipMetadata } from '../types.js';
import { discoverNpmPackages } from './npm-packages.js';

/** A `packageRoot` fact from Cargo or npm. Python roots come from its entry-point resolution. */
export interface RepositoryPackageRoot {
  readonly packageId: string;
  readonly file: string;
}

/** A `dependsOn` edge between two packages, with `kind` and any `cfg` as metadata. */
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
  readonly problems: readonly RepositoryPackageProblem[];
}

/**
 * Discovers the packages of every ecosystem in a repository. The result is the same for the same
 * files, whatever order they arrive in.
 *
 * @param filePaths the repository files that passed the scan and the configured filters
 * @param readText reads a repository-relative file, and returns `''` when it cannot be read
 * @param exists whether a repository-relative path exists on disk, including unscanned files
 */
export function discoverRepositoryPackages(
  filePaths: readonly string[],
  readText: (path: string) => string,
  exists: (path: string) => boolean = () => false,
): RepositoryPackages {
  const cargo = discoverCargoPackages(filePaths, readText);
  const npm = discoverNpmPackages(filePaths, readText, exists);
  const python = discoverPythonPackages(filePaths, readText);

  return {
    packages: [...cargo.packages, ...npm.packages, ...python.packages],
    packageRoots: [...cargo.packageRoots, ...npm.packageRoots],
    dependencies: [
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
    ],
    python,
    problems: [...cargo.problems, ...npm.problems, ...python.problems],
  };
}
