import { posix } from 'node:path';
import { normalizePath } from '../../../path-utils.js';
import type { PackageNode } from '../../../types.js';
import {
  type CargoManifest,
  type CargoManifestProblem,
  parseCargoManifest,
  resolveWorkspaceInheritance,
} from './manifest.js';
import {
  type CargoExtern,
  type CargoPackageDependency,
  type CargoPackageInput,
  resolveCargoDependencies,
} from './dependencies.js';
import { discoverTargets } from './targets.js';
import { unmatchedMemberPatterns, workspaceMemberDirs } from './workspace-members.js';

/** A `packageRoot` fact: the file a target is built from (V3 Phase 7.2). */
export interface CargoPackageRoot {
  readonly packageId: string;
  readonly file: string;
}

/** What the Cargo manifests in a repository declare, before edges are drawn. */
export interface CargoPackageDiscovery {
  /** Sorted by id: one node per target */
  readonly packages: readonly PackageNode[];
  /** Sorted by package id, then file */
  readonly packageRoots: readonly CargoPackageRoot[];
  /** Every parsed manifest, resolved against its workspace and sorted by path */
  readonly manifests: readonly CargoManifest[];
  /** `dependsOn` edges between targets in the repository */
  readonly dependencies: readonly CargoPackageDependency[];
  /** Dependencies that are not packages in the repository, for name resolution */
  readonly externs: readonly CargoExtern[];
  readonly problems: readonly CargoManifestProblem[];
}

/** Cargo's edition when `[package]` does not set one. */
const DEFAULT_EDITION = '2015';

/**
 * Discovers the Cargo packages in a repository: every `Cargo.toml` is parsed, inherits from the
 * workspace that owns it, and yields one package node per target.
 *
 * @param filePaths every repository file, with `/` separators
 * @param readText reads a manifest's contents by repository-relative path
 */
export function discoverCargoPackages(
  filePaths: readonly string[],
  readText: (path: string) => string,
): CargoPackageDiscovery {
  const files = new Set(filePaths.map(normalizePath));
  const parsed = new Map<string, CargoManifest>();
  for (const path of [...files].sort()) {
    if (posix.basename(path) !== 'Cargo.toml') continue;
    parsed.set(posix.dirname(path), parseCargoManifest(path, readText(path)));
  }

  const dirs = [...parsed.keys()].sort(compareText);
  const memberDirs = new Map<string, ReadonlySet<string>>();
  for (const dir of dirs) {
    const manifest = parsed.get(dir);
    if (manifest?.workspace) {
      memberDirs.set(
        dir,
        workspaceMemberDirs(dir, manifest.workspace, dirs, manifest.package !== undefined),
      );
    }
  }

  const packages: PackageNode[] = [];
  const packageRoots: CargoPackageRoot[] = [];
  const manifests: CargoManifest[] = [];
  const inputs: CargoPackageInput[] = [];
  const problems: CargoManifestProblem[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    const manifest = parsed.get(dir);
    if (!manifest?.workspace) continue;
    for (const pattern of unmatchedMemberPatterns(dir, manifest.workspace, dirs)) {
      problems.push({
        path: manifest.path,
        message: `workspace member "${pattern}" matches no package`,
      });
    }
  }

  for (const dir of dirs) {
    const manifest = parsed.get(dir);
    if (!manifest) continue;

    let root: CargoManifest | undefined;
    const owner = workspaceOwner(dir, parsed);
    // Only a package has to be a member: a virtual or unparseable manifest needs no membership.
    if (owner !== undefined && manifest.package !== undefined) {
      if (owner === dir || memberDirs.get(owner)?.has(dir)) {
        root = parsed.get(owner);
      } else {
        problems.push({
          path: manifest.path,
          message: `package is inside the workspace at ${owner} but is not one of its members`,
        });
      }
    }

    const resolved = resolveWorkspaceInheritance(manifest, root);
    manifests.push(resolved);
    problems.push(...resolved.problems);
    if (!resolved.package) continue;

    const edition = resolved.package.edition ?? DEFAULT_EDITION;
    const targets = discoverTargets(resolved, dir, files);
    inputs.push({ dir, manifest: resolved, targets });
    for (const target of targets) {
      if (seen.has(target.id)) continue;
      seen.add(target.id);
      if (target.missing !== undefined) {
        problems.push({
          path: manifest.path,
          message: `${target.kind} target "${target.name}" has no source file at "${target.missing}"`,
        });
      }
      packages.push({
        kind: 'package',
        id: target.id,
        ecosystem: 'cargo',
        name: target.name,
        target: target.kind,
        manifest: manifest.path,
        roots: target.root === undefined ? [] : [target.root],
        edition,
      });
      if (target.root !== undefined) packageRoots.push({ packageId: target.id, file: target.root });
    }
  }

  packages.sort((a, b) => compareText(a.id, b.id));
  packageRoots.sort((a, b) => compareText(a.packageId, b.packageId) || compareText(a.file, b.file));
  manifests.sort((a, b) => compareText(a.path, b.path));
  const { dependencies, externs } = resolveCargoDependencies(inputs, problems);
  return { packages, packageRoots, manifests, dependencies, externs, problems };
}

/** The directory of the nearest manifest with a `[workspace]` table, starting at `dir` itself. */
function workspaceOwner(
  dir: string,
  parsed: ReadonlyMap<string, CargoManifest>,
): string | undefined {
  let current = dir;
  for (;;) {
    if (parsed.get(current)?.workspace) return current;
    if (current === '.') return undefined;
    current = posix.dirname(current);
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
