import type { CargoDependencyKind, CargoManifest, CargoManifestProblem } from './manifest.js';
import { codeName, type CargoTarget } from './targets.js';

/** The kind of a `dependsOn` edge, stored as `metadata.kind` (V3 Phase 7.3). */
export type CargoEdgeKind = 'normal' | 'dev' | 'build' | 'optional';

/**
 * A dependency from one target to a library in the repository. Normal dependencies start at every
 * target except build scripts, dev dependencies at tests, examples and benches, and build
 * dependencies at the build script. Each bin, test, example and bench also depends on its own
 * package's library (`implicit`).
 */
export interface CargoPackageDependency {
  /** The depending target's id */
  readonly from: string;
  /** The library target id of the package it depends on */
  readonly to: string;
  readonly kind: CargoEdgeKind;
  /** The name code uses for the dependency: its table key, with `-` changed to `_` */
  readonly name: string;
  /** The `cfg(...)` or target triple of a `[target.<x>]` table, as written */
  readonly cfg?: string;
  readonly implicit: boolean;
  /** Repository-relative path of the manifest that declares the dependency */
  readonly manifest: string;
}

/** A dependency that is not a package inside the repository: a registry, git or outside-path crate. */
export interface CargoExtern {
  readonly manifest: string;
  /** The name code uses: the table key, with `-` changed to `_` */
  readonly name: string;
  readonly kind: CargoDependencyKind;
  readonly source: 'registry' | 'git' | 'path';
}

/** A package's directory, its resolved manifest and its discovered targets. */
export interface CargoPackageInput {
  readonly dir: string;
  readonly manifest: CargoManifest;
  readonly targets: readonly CargoTarget[];
}

export interface CargoDependencyResolution {
  /** Sorted by source, target, kind, name and cfg */
  readonly dependencies: readonly CargoPackageDependency[];
  /** Sorted by manifest, name and kind */
  readonly externs: readonly CargoExtern[];
}

/**
 * Turns declared dependencies into `dependsOn` edges between targets in the repository, and
 * collects everything else into the extern table, which name resolution (Phase 9) reads.
 *
 * A path dependency whose directory has no library target yields a problem and no edge. A
 * path that leaves the repository is an extern, like a registry crate.
 *
 * @param packages every package with a package node, in any order
 * @param problems receives one problem per dependency that names no library
 */
export function resolveCargoDependencies(
  packages: readonly CargoPackageInput[],
  problems: CargoManifestProblem[],
): CargoDependencyResolution {
  const libraryByDir = new Map<string, CargoTarget>();
  for (const pkg of packages) {
    const library = libraryOf(pkg.targets);
    if (library) libraryByDir.set(pkg.dir, library);
  }

  const edges = new Map<string, CargoPackageDependency>();
  const externs = new Map<string, CargoExtern>();
  for (const pkg of packages) {
    const manifest = pkg.manifest.path;
    for (const dep of pkg.manifest.dependencies) {
      if (dep.workspace) continue; // unresolved; the manifest parser already reported it
      const name = codeName(dep.key);
      if (dep.path !== undefined && !leavesRepository(dep.path)) {
        const library = libraryByDir.get(dep.path);
        if (!library) {
          problems.push({
            path: manifest,
            message: `path dependency "${dep.key}" at "${dep.path}" names no package with a library target`,
          });
          continue;
        }
        const kind: CargoEdgeKind = dep.optional ? 'optional' : dep.kind;
        for (const source of sourcesFor(dep.kind, pkg.targets)) {
          addEdge(edges, {
            from: source.id,
            to: library.id,
            kind,
            name,
            cfg: dep.target,
            implicit: false,
            manifest,
          });
        }
        continue;
      }
      const source: CargoExtern['source'] =
        dep.path !== undefined ? 'path' : dep.git !== undefined ? 'git' : 'registry';
      externs.set(`${manifest}\u0000${name}\u0000${dep.kind}`, {
        manifest,
        name,
        kind: dep.kind,
        source,
      });
    }

    const own = libraryOf(pkg.targets);
    if (own) {
      for (const target of pkg.targets) {
        if (!IMPLICIT_SOURCE_KINDS.has(target.kind)) continue;
        addEdge(edges, {
          from: target.id,
          to: own.id,
          kind: 'normal',
          name: own.name,
          implicit: true,
          manifest,
        });
      }
    }
  }

  return {
    dependencies: [...edges.values()].sort(
      (a, b) =>
        compareText(a.from, b.from) ||
        compareText(a.to, b.to) ||
        compareText(a.kind, b.kind) ||
        compareText(a.name, b.name) ||
        compareText(a.cfg ?? '', b.cfg ?? ''),
    ),
    externs: [...externs.values()].sort(
      (a, b) =>
        compareText(a.manifest, b.manifest) ||
        compareText(a.name, b.name) ||
        compareText(a.kind, b.kind),
    ),
  };
}

/** Target kinds that depend on their own package's library. */
const IMPLICIT_SOURCE_KINDS: ReadonlySet<string> = new Set(['bin', 'example', 'test', 'bench']);

function libraryOf(targets: readonly CargoTarget[]): CargoTarget | undefined {
  return targets.find((target) => target.kind === 'lib' || target.kind === 'proc-macro');
}

/** The targets a dependency of this kind is visible to. */
function sourcesFor(kind: CargoDependencyKind, targets: readonly CargoTarget[]): CargoTarget[] {
  if (kind === 'build') return targets.filter((target) => target.kind === 'build-script');
  if (kind === 'dev') {
    return targets.filter(
      (target) => target.kind === 'test' || target.kind === 'example' || target.kind === 'bench',
    );
  }
  return targets.filter((target) => target.kind !== 'build-script');
}

/** A repository-relative path that climbs out of the repository. */
function leavesRepository(path: string): boolean {
  return path === '..' || path.startsWith('../');
}

function addEdge(edges: Map<string, CargoPackageDependency>, edge: CargoPackageDependency): void {
  if (edge.from === edge.to) return;
  const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}\u0000${edge.name}\u0000${edge.cfg ?? ''}`;
  if (!edges.has(key)) edges.set(key, edge);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
