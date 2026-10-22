import type { PackageTargetKind } from '../../../types.js';
import { type CargoManifest, type CargoTargetDecl, joinRepoPath } from './manifest.js';

/** A build target of a Cargo package, before it becomes a package node (V3 Phase 7.2). */
export interface CargoTarget {
  /** `package:cargo:<manifest dir>#<kind>:<name>` */
  readonly id: string;
  readonly kind: PackageTargetKind;
  /** The name as code uses it: `-` changed to `_` */
  readonly name: string;
  /** Repository-relative root file. Absent when the file does not exist. */
  readonly root?: string;
  /** Found by auto-discovery rather than declared in the manifest */
  readonly inferred: boolean;
}

interface KindRules {
  readonly kind: PackageTargetKind;
  readonly declared: readonly CargoTargetDecl[];
  /** `autobins` and its siblings. Absent means on. */
  readonly auto: boolean | undefined;
  /** The directory auto-discovery scans, relative to the package */
  readonly dir: string;
  /** Binaries only: `src/main.rs` is the binary named after the package */
  readonly mainFile?: string;
}

/** The code name of a target: `-` changed to `_`, as code uses it. */
export function codeName(name: string): string {
  return name.replace(/-/g, '_');
}

/** The id of a target node. The name is the code name, so ids match how code refers to targets. */
export function targetId(packageDir: string, kind: PackageTargetKind, name: string): string {
  return `package:cargo:${packageDir}#${kind}:${codeName(name)}`;
}

/**
 * The build targets of one package. Explicit tables take precedence over auto-discovery: an
 * inferred target is dropped when an explicit target of the same kind has the same name or root.
 * A package without a name yields nothing, because Cargo rejects it (reported in Phase 7.4).
 *
 * @param manifest the manifest, already resolved against its workspace
 * @param packageDir repository-relative directory of the manifest
 * @param files every repository file, so that a root is only reported when it exists
 */
export function discoverTargets(
  manifest: CargoManifest,
  packageDir: string,
  files: ReadonlySet<string>,
): CargoTarget[] {
  const pkg = manifest.package;
  if (pkg?.name === undefined) return [];
  const packageName = pkg.name;
  const at = (relative: string): string => joinRepoPath(packageDir, relative);
  const prefix = packageDir === '.' ? '' : `${packageDir}/`;

  const make = (
    kind: PackageTargetKind,
    name: string,
    root: string | undefined,
    inferred: boolean,
  ): CargoTarget => ({
    id: targetId(packageDir, kind, name),
    kind,
    name: codeName(name),
    root: root !== undefined && files.has(root) ? root : undefined,
    inferred,
  });

  const targets: CargoTarget[] = [];

  const libDecl = manifest.lib;
  if (libDecl || files.has(at('src/lib.rs'))) {
    const kind: PackageTargetKind = libDecl?.procMacro ? 'proc-macro' : 'lib';
    targets.push(
      make(kind, libDecl?.name ?? packageName, libDecl?.path ?? at('src/lib.rs'), !libDecl),
    );
  }

  if (pkg.build === undefined) {
    if (files.has(at('build.rs')))
      targets.push(make('build-script', 'build', at('build.rs'), true));
  } else if (typeof pkg.build === 'string') {
    targets.push(make('build-script', 'build', pkg.build, false));
  }

  const rules: KindRules[] = [
    {
      kind: 'bin',
      declared: manifest.bins,
      auto: pkg.autobins,
      dir: 'src/bin',
      mainFile: 'src/main.rs',
    },
    { kind: 'example', declared: manifest.examples, auto: pkg.autoexamples, dir: 'examples' },
    { kind: 'test', declared: manifest.tests, auto: pkg.autotests, dir: 'tests' },
    { kind: 'bench', declared: manifest.benches, auto: pkg.autobenches, dir: 'benches' },
  ];

  for (const rule of rules) {
    const declared = rule.declared.map((decl) => {
      const name = decl.name ?? packageName;
      return make(rule.kind, name, decl.path ?? defaultRoot(rule, name), false);
    });

    const inferred: CargoTarget[] = [];
    if (rule.auto !== false) {
      for (const [name, root] of autoDiscover(rule)) {
        inferred.push(make(rule.kind, name, root, true));
      }
    }
    const kept = inferred.filter(
      (candidate) =>
        !declared.some(
          (decl) =>
            decl.name === candidate.name ||
            (decl.root !== undefined && decl.root === candidate.root),
        ),
    );
    targets.push(...declared, ...kept);
  }

  return targets;

  /** An explicit target without a path: the file Cargo would infer from its name. */
  function defaultRoot(rule: KindRules, name: string): string | undefined {
    const candidates: string[] = [];
    if (rule.mainFile !== undefined && name === packageName) candidates.push(at(rule.mainFile));
    candidates.push(at(`${rule.dir}/${name}.rs`), at(`${rule.dir}/${name}/main.rs`));
    return candidates.find((candidate) => files.has(candidate));
  }

  /** The targets auto-discovery finds for one kind, as `[name, root]` sorted by name. */
  function autoDiscover(rule: KindRules): [string, string][] {
    const found = new Map<string, string>();
    for (const file of [...files].sort()) {
      if (!file.startsWith(prefix)) continue;
      const relative = file.slice(prefix.length);
      if (rule.mainFile !== undefined && relative === rule.mainFile) {
        if (!found.has(packageName)) found.set(packageName, file);
        continue;
      }
      const dirPrefix = `${rule.dir}/`;
      if (!relative.startsWith(dirPrefix)) continue;
      const rest = relative.slice(dirPrefix.length);
      let name: string | undefined;
      if (rest.endsWith('.rs') && !rest.includes('/')) name = rest.slice(0, -'.rs'.length);
      else if (rest.endsWith('/main.rs') && rest.split('/').length === 2) name = rest.split('/')[0];
      if (name !== undefined && name.length > 0 && !found.has(name)) found.set(name, file);
    }
    return [...found.entries()].sort(([a], [b]) => compareText(a, b));
  }
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
