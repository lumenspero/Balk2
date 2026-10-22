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
    packageRoots: [...cargo.packageRoots, ...npm.packageRoots],
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
