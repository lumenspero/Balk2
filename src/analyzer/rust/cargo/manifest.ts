import { posix } from 'node:path';
import { parse as parseToml } from 'smol-toml';

/** The dependency table a dependency comes from (V3 Phase 7.1). */
export type CargoDependencyKind = 'normal' | 'dev' | 'build';

/**
 * A dependency as a manifest declares it. `path` is repository-relative, resolved against the
 * manifest's own directory, so a path taken from `[workspace.dependencies]` keeps its meaning.
 */
export interface CargoDependency {
  /** The table key: the name the manifest gives the dependency */
  readonly key: string;
  /** The crate it resolves to: the `package` rename, or the key */
  readonly crate: string;
  readonly kind: CargoDependencyKind;
  /** The cfg expression or target triple of a `[target.<x>.<table>]` section, as written */
  readonly target?: string;
  readonly optional: boolean;
  readonly path?: string;
  readonly git?: string;
  readonly registry?: string;
  readonly version?: string;
  /** True while a `{ workspace = true }` entry waits for `resolveWorkspaceInheritance` */
  readonly workspace: boolean;
}

/** A `[lib]`, `[[bin]]`, `[[example]]`, `[[test]]` or `[[bench]]` table, as written. */
export interface CargoTargetDecl {
  readonly name?: string;
  /** Repository-relative, resolved against the manifest's directory */
  readonly path?: string;
  /** `proc-macro = true`, which is meaningful on `[lib]` */
  readonly procMacro: boolean;
}

/**
 * The `[package]` table. Fields that say `{ workspace = true }` are listed in `inherits` until
 * `resolveWorkspaceInheritance` fills them in.
 */
export interface CargoPackageSection {
  readonly name?: string;
  readonly version?: string;
  /** Absent means the Cargo default, which is 2015 */
  readonly edition?: string;
  /** Repository-relative build script path, `false` to disable it, or absent for `build.rs` */
  readonly build?: string | false;
  readonly autobins?: boolean;
  readonly autoexamples?: boolean;
  readonly autotests?: boolean;
  readonly autobenches?: boolean;
  readonly inherits: readonly string[];
}

/** The `[workspace]` table, plus `[workspace.package]` and `[workspace.dependencies]`. */
export interface CargoWorkspaceSection {
  /** Member globs, as written and relative to the manifest's directory. Expanded in Phase 7.2. */
  readonly members: readonly string[];
  readonly exclude: readonly string[];
  readonly defaultMembers: readonly string[];
  /** Values from `[workspace.package]`, keyed by field name */
  readonly package: Readonly<Record<string, unknown>>;
  /** Entries from `[workspace.dependencies]` */
  readonly dependencies: readonly CargoDependency[];
}

/** A manifest that cannot be read or understood. The parser keeps going and reports it here. */
export interface CargoManifestProblem {
  readonly path: string;
  readonly message: string;
}

/** One Cargo manifest, as declared. Target discovery and graph output happen in later phases. */
export interface CargoManifest {
  /** Repository-relative path of the manifest */
  readonly path: string;
  readonly package?: CargoPackageSection;
  readonly lib?: CargoTargetDecl;
  readonly bins: readonly CargoTargetDecl[];
  readonly examples: readonly CargoTargetDecl[];
  readonly tests: readonly CargoTargetDecl[];
  readonly benches: readonly CargoTargetDecl[];
  /** Normal, dev and build dependencies, including target-specific tables */
  readonly dependencies: readonly CargoDependency[];
  readonly workspace?: CargoWorkspaceSection;
  readonly problems: readonly CargoManifestProblem[];
}

type Table = Readonly<Record<string, unknown>>;

interface Context {
  readonly path: string;
  readonly problems: CargoManifestProblem[];
}

interface DependencyOrigin {
  readonly kind: CargoDependencyKind;
  readonly target?: string;
  /** Repository-relative directory of the manifest */
  readonly dir: string;
}

/** The edition assumed for a package whose inherited edition has no workspace in the repository. */
const UNRESOLVED_EDITION = '2021';

const DEPENDENCY_TABLES: readonly { readonly table: string; readonly kind: CargoDependencyKind }[] =
  [
    { table: 'dependencies', kind: 'normal' },
    { table: 'dev-dependencies', kind: 'dev' },
    { table: 'build-dependencies', kind: 'build' },
  ];

/**
 * Parses one `Cargo.toml`. It never throws: a TOML syntax error or a value of the wrong type is
 * reported in `problems`, and everything else is still read.
 *
 * @param path repository-relative path of the manifest, with `/` separators
 * @param text the manifest's contents
 */
export function parseCargoManifest(path: string, text: string): CargoManifest {
  const ctx: Context = { path, problems: [] };
  let root: Table;
  try {
    root = parseToml(text);
  } catch (error) {
    report(ctx, `invalid TOML: ${error instanceof Error ? error.message : String(error)}`);
    return emptyManifest(path, ctx.problems);
  }

  const dir = posix.dirname(path);
  const packageTable = tableValue(ctx, root.package, '[package]');
  const libTable = tableValue(ctx, root.lib, '[lib]');
  const workspaceTable = tableValue(ctx, root.workspace, '[workspace]');

  return {
    path,
    package: packageTable ? parsePackage(ctx, packageTable, dir) : undefined,
    lib: libTable ? parseTarget(ctx, libTable, '[lib].', dir) : undefined,
    bins: parseTargetList(ctx, root, 'bin', dir),
    examples: parseTargetList(ctx, root, 'example', dir),
    tests: parseTargetList(ctx, root, 'test', dir),
    benches: parseTargetList(ctx, root, 'bench', dir),
    dependencies: [
      ...parseDependencyTables(ctx, root, { dir }, ''),
      ...parseTargetDependencies(ctx, root, dir),
    ],
    workspace: workspaceTable ? parseWorkspace(ctx, workspaceTable, dir) : undefined,
    problems: ctx.problems,
  };
}

/**
 * Fills in every `{ workspace = true }` field and dependency of `member` from `root`, the manifest
 * that declares `[workspace]`. Paths from `[workspace.dependencies]` are already relative to the
 * repository, so they are copied as they are.
 */
export function resolveWorkspaceInheritance(
  member: CargoManifest,
  root: CargoManifest | undefined,
): CargoManifest {
  const ctx: Context = { path: member.path, problems: [...member.problems] };
  const shared = root?.workspace;
  return {
    ...member,
    package: member.package ? resolvePackage(ctx, member.package, shared) : undefined,
    dependencies: member.dependencies.map((dep) => resolveDependency(ctx, dep, shared)),
    problems: ctx.problems,
  };
}

function emptyManifest(path: string, problems: CargoManifestProblem[]): CargoManifest {
  return { path, bins: [], examples: [], tests: [], benches: [], dependencies: [], problems };
}

function parsePackage(ctx: Context, table: Table, dir: string): CargoPackageSection {
  const inherits: string[] = [];
  for (const [key, value] of Object.entries(table)) {
    if (isWorkspaceInherit(value)) inherits.push(key);
  }
  const scalar = (key: string): unknown => (inherits.includes(key) ? undefined : table[key]);
  return {
    name: stringValue(ctx, scalar('name'), '[package] name'),
    version: stringValue(ctx, scalar('version'), '[package] version'),
    edition: stringValue(ctx, scalar('edition'), '[package] edition'),
    build: buildValue(ctx, scalar('build'), dir),
    autobins: boolValue(ctx, scalar('autobins'), '[package] autobins'),
    autoexamples: boolValue(ctx, scalar('autoexamples'), '[package] autoexamples'),
    autotests: boolValue(ctx, scalar('autotests'), '[package] autotests'),
    autobenches: boolValue(ctx, scalar('autobenches'), '[package] autobenches'),
    inherits,
  };
}

function parseTarget(ctx: Context, table: Table, label: string, dir: string): CargoTargetDecl {
  return {
    name: stringValue(ctx, table.name, `${label}name`),
    path: pathValue(ctx, table.path, `${label}path`, dir),
    procMacro: boolValue(ctx, table['proc-macro'], `${label}proc-macro`) ?? false,
  };
}

function parseTargetList(ctx: Context, root: Table, key: string, dir: string): CargoTargetDecl[] {
  const value = root[key];
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    report(ctx, `[[${key}]] must be an array of tables`);
    return [];
  }
  const targets: CargoTargetDecl[] = [];
  value.forEach((entry: unknown, index: number) => {
    if (isTable(entry)) {
      targets.push(parseTarget(ctx, entry, `[[${key}]][${index}].`, dir));
    } else {
      report(ctx, `[[${key}]][${index}] must be a table`);
    }
  });
  return targets;
}

function parseDependencyTables(
  ctx: Context,
  table: Table,
  origin: { readonly dir: string; readonly target?: string },
  labelPrefix: string,
): CargoDependency[] {
  const dependencies: CargoDependency[] = [];
  for (const { table: name, kind } of DEPENDENCY_TABLES) {
    const section = tableValue(ctx, table[name], `${labelPrefix}${name}`);
    if (!section) continue;
    for (const [key, spec] of Object.entries(section)) {
      const dependency = parseDependency(
        ctx,
        key,
        spec,
        { kind, target: origin.target, dir: origin.dir },
        `${labelPrefix}${name}.${key}`,
      );
      if (dependency) dependencies.push(dependency);
    }
  }
  return dependencies;
}

function parseTargetDependencies(ctx: Context, root: Table, dir: string): CargoDependency[] {
  const targets = tableValue(ctx, root.target, '[target]');
  if (!targets) return [];
  return Object.entries(targets).flatMap(([cfg, section]) => {
    const sectionTable = tableValue(ctx, section, `[target.${cfg}]`);
    return sectionTable
      ? parseDependencyTables(ctx, sectionTable, { dir, target: cfg }, `target.${cfg}.`)
      : [];
  });
}

function parseDependency(
  ctx: Context,
  key: string,
  spec: unknown,
  origin: DependencyOrigin,
  label: string,
): CargoDependency | undefined {
  if (typeof spec === 'string') {
    return {
      key,
      crate: key,
      kind: origin.kind,
      target: origin.target,
      optional: false,
      version: spec,
      workspace: false,
    };
  }
  if (!isTable(spec)) {
    report(ctx, `${label} must be a version string or a table`);
    return undefined;
  }
  const rename = stringValue(ctx, spec.package, `${label}.package`);
  return {
    key,
    crate: rename ?? key,
    kind: origin.kind,
    target: origin.target,
    optional: boolValue(ctx, spec.optional, `${label}.optional`) ?? false,
    path: pathValue(ctx, spec.path, `${label}.path`, origin.dir),
    git: stringValue(ctx, spec.git, `${label}.git`),
    registry: stringValue(ctx, spec.registry, `${label}.registry`),
    version: stringValue(ctx, spec.version, `${label}.version`),
    workspace: boolValue(ctx, spec.workspace, `${label}.workspace`) ?? false,
  };
}

function parseWorkspace(ctx: Context, table: Table, dir: string): CargoWorkspaceSection {
  const packageValues: Table = tableValue(ctx, table.package, '[workspace.package]') ?? {};
  const dependencyTable = tableValue(ctx, table.dependencies, '[workspace.dependencies]');
  const dependencies: CargoDependency[] = [];
  for (const [key, spec] of Object.entries(dependencyTable ?? {})) {
    const dependency = parseDependency(
      ctx,
      key,
      spec,
      { kind: 'normal', dir },
      `workspace.dependencies.${key}`,
    );
    if (!dependency) continue;
    if (dependency.workspace) {
      report(ctx, `workspace.dependencies.${key} cannot inherit from the workspace`);
      continue;
    }
    dependencies.push(dependency);
  }
  return {
    members: stringListValue(ctx, table.members, '[workspace] members'),
    exclude: stringListValue(ctx, table.exclude, '[workspace] exclude'),
    defaultMembers: stringListValue(ctx, table['default-members'], '[workspace] default-members'),
    package: packageValues,
    dependencies,
  };
}

function resolvePackage(
  ctx: Context,
  pkg: CargoPackageSection,
  shared: CargoWorkspaceSection | undefined,
): CargoPackageSection {
  if (pkg.inherits.length === 0) return pkg;
  let { edition, version } = pkg;
  for (const field of pkg.inherits) {
    if (field === 'name') {
      report(ctx, '[package] name cannot inherit from the workspace');
      continue;
    }
    const value = shared?.package[field];
    if (value === undefined) {
      report(ctx, `[package] ${field} inherits from [workspace.package], which does not set it`);
      // The edition is unknown without its workspace. 2021 is assumed: under the 2015 default,
      // bare module paths resolve from the crate root, which later editions do not do.
      if (field === 'edition') edition = edition ?? UNRESOLVED_EDITION;
      continue;
    }
    if (field === 'edition' || field === 'version') {
      if (typeof value !== 'string') {
        report(ctx, `[workspace.package] ${field} must be a string`);
      } else if (field === 'edition') {
        edition = value;
      } else {
        version = value;
      }
    }
  }
  return { ...pkg, edition, version, inherits: [] };
}

function resolveDependency(
  ctx: Context,
  dep: CargoDependency,
  shared: CargoWorkspaceSection | undefined,
): CargoDependency {
  if (!dep.workspace) return dep;
  const source = shared?.dependencies.find((entry) => entry.key === dep.key);
  if (!source) {
    report(ctx, `dependency ${dep.key} inherits from [workspace.dependencies], which lacks it`);
    return { ...dep, workspace: false };
  }
  return {
    ...dep,
    crate: source.crate,
    version: source.version,
    path: source.path,
    git: source.git,
    registry: source.registry,
    workspace: false,
  };
}

function buildValue(ctx: Context, value: unknown, dir: string): string | false | undefined {
  if (value === undefined) return undefined;
  if (value === false) return false;
  if (typeof value === 'string') return joinRepoPath(dir, value);
  report(ctx, '[package] build must be a path or false');
  return undefined;
}

function pathValue(ctx: Context, value: unknown, label: string, dir: string): string | undefined {
  const text = stringValue(ctx, value, label);
  return text === undefined ? undefined : joinRepoPath(dir, text);
}

function stringValue(ctx: Context, value: unknown, label: string): string | undefined {
  if (value === undefined || typeof value === 'string') return value;
  report(ctx, `${label} must be a string`);
  return undefined;
}

function boolValue(ctx: Context, value: unknown, label: string): boolean | undefined {
  if (value === undefined || typeof value === 'boolean') return value;
  report(ctx, `${label} must be true or false`);
  return undefined;
}

function stringListValue(ctx: Context, value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    if (items.every((item): item is string => typeof item === 'string')) return items;
  }
  report(ctx, `${label} must be an array of strings`);
  return [];
}

function tableValue(ctx: Context, value: unknown, label: string): Table | undefined {
  if (value === undefined || isTable(value)) return value;
  report(ctx, `${label} must be a table`);
  return undefined;
}

function isTable(value: unknown): value is Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWorkspaceInherit(value: unknown): boolean {
  return isTable(value) && value.workspace === true;
}

export function joinRepoPath(dir: string, relative: string): string {
  return posix.normalize(posix.join(dir, relative));
}

function report(ctx: Context, message: string): void {
  ctx.problems.push({ path: ctx.path, message });
}
