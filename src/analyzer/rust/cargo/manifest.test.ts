import { describe, expect, it } from 'vitest';
import { parseCargoManifest, resolveWorkspaceInheritance } from './manifest.js';

const SINGLE_CRATE = `
[package]
name = "ingest-core"
version = "0.1.0"
edition = "2021"
build = "build.rs"
autobins = false
autotests = true

[lib]
name = "ingest"
path = "src/lib.rs"

[[bin]]
name = "ingest-cli"
path = "src/bin/cli.rs"

[dependencies]
serde = "1.0"
tokio = { version = "1", features = ["rt"], optional = true }
local = { path = "../local" }
renamed = { package = "real-name", version = "2" }
git-dep = { git = "https://example.com/x.git" }
alt = { registry = "corp", version = "3" }

[dev-dependencies]
tempfile = "3"

[build-dependencies]
cc = "1"

[target.'cfg(windows)'.dependencies]
winapi = "0.3"

[target.x86_64-unknown-linux-gnu.dev-dependencies]
libc = "0.2"
`;

const VIRTUAL_WORKSPACE = `
[workspace]
members = ["crates/*", "tools/cli"]
exclude = ["crates/old"]
default-members = ["crates/ingest"]
resolver = "2"

[workspace.package]
version = "1.2.3"
edition = "2021"
license = "MIT"

[workspace.dependencies]
serde = { version = "1", features = ["derive"] }
core = { path = "crates/core" }
`;

describe('parseCargoManifest: [package]', () => {
  it('reads name, version, edition, build and the auto flags', () => {
    const manifest = parseCargoManifest('crates/app/Cargo.toml', SINGLE_CRATE);
    expect(manifest.problems).toEqual([]);
    expect(manifest.package).toEqual({
      name: 'ingest-core',
      version: '0.1.0',
      edition: '2021',
      build: 'crates/app/build.rs',
      autobins: false,
      autotests: true,
      inherits: [],
    });
  });

  it('leaves edition absent when the manifest does not set it', () => {
    const manifest = parseCargoManifest('Cargo.toml', '[package]\nname = "a"\n');
    expect(manifest.package?.edition).toBeUndefined();
  });

  it('keeps build = false and reports no build script path', () => {
    const manifest = parseCargoManifest('Cargo.toml', '[package]\nname = "a"\nbuild = false\n');
    expect(manifest.package?.build).toBe(false);
  });

  it('has no package section for a virtual manifest', () => {
    const manifest = parseCargoManifest('Cargo.toml', VIRTUAL_WORKSPACE);
    expect(manifest.package).toBeUndefined();
  });
});

describe('parseCargoManifest: targets', () => {
  it('reads [lib], [[bin]], [[example]], [[test]] and [[bench]] with repository-relative paths', () => {
    const text = `
[lib]
path = "src/lib.rs"
proc-macro = true

[[bin]]
name = "a"

[[example]]
name = "demo"
path = "examples/demo/main.rs"

[[test]]
name = "it"

[[bench]]
name = "speed"
path = "benches/speed.rs"
`;
    const manifest = parseCargoManifest('crates/x/Cargo.toml', text);
    expect(manifest.problems).toEqual([]);
    expect(manifest.lib).toEqual({ path: 'crates/x/src/lib.rs', procMacro: true });
    expect(manifest.bins).toEqual([{ name: 'a', procMacro: false }]);
    expect(manifest.examples).toEqual([
      { name: 'demo', path: 'crates/x/examples/demo/main.rs', procMacro: false },
    ]);
    expect(manifest.tests).toEqual([{ name: 'it', procMacro: false }]);
    expect(manifest.benches).toEqual([
      { name: 'speed', path: 'crates/x/benches/speed.rs', procMacro: false },
    ]);
  });
});

describe('parseCargoManifest: dependencies', () => {
  const manifest = parseCargoManifest('crates/app/Cargo.toml', SINGLE_CRATE);
  const find = (key: string, kind = 'normal'): unknown =>
    manifest.dependencies.find((dep) => dep.key === key && dep.kind === kind);

  it('reads version strings and version tables, including optional', () => {
    expect(find('serde')).toMatchObject({ crate: 'serde', version: '1.0', optional: false });
    expect(find('tokio')).toMatchObject({ version: '1', optional: true, workspace: false });
  });

  it('resolves path dependencies to repository-relative paths', () => {
    expect(find('local')).toMatchObject({ path: 'crates/local' });
  });

  it('uses the package rename as the crate name', () => {
    expect(find('renamed')).toMatchObject({ key: 'renamed', crate: 'real-name', version: '2' });
  });

  it('reads git and registry sources', () => {
    expect(find('git-dep')).toMatchObject({ git: 'https://example.com/x.git' });
    expect(find('alt')).toMatchObject({ registry: 'corp', version: '3' });
  });

  it('separates dev and build dependency tables', () => {
    expect(find('tempfile', 'dev')).toMatchObject({ version: '3', kind: 'dev' });
    expect(find('cc', 'build')).toMatchObject({ version: '1', kind: 'build' });
  });

  it('records the cfg of a target-specific table and its kind', () => {
    expect(find('winapi')).toMatchObject({ target: 'cfg(windows)', kind: 'normal' });
    expect(find('libc', 'dev')).toMatchObject({
      target: 'x86_64-unknown-linux-gnu',
      kind: 'dev',
    });
  });

  it('keeps every dependency once, in manifest order', () => {
    expect(manifest.dependencies.map((dep) => dep.key)).toEqual([
      'serde',
      'tokio',
      'local',
      'renamed',
      'git-dep',
      'alt',
      'tempfile',
      'cc',
      'winapi',
      'libc',
    ]);
  });
});

describe('parseCargoManifest: [workspace]', () => {
  const manifest = parseCargoManifest('Cargo.toml', VIRTUAL_WORKSPACE);

  it('reads members, exclude, default-members and the workspace package table', () => {
    expect(manifest.problems).toEqual([]);
    expect(manifest.workspace?.members).toEqual(['crates/*', 'tools/cli']);
    expect(manifest.workspace?.exclude).toEqual(['crates/old']);
    expect(manifest.workspace?.defaultMembers).toEqual(['crates/ingest']);
    expect(manifest.workspace?.package).toEqual({
      version: '1.2.3',
      edition: '2021',
      license: 'MIT',
    });
  });

  it('reads workspace dependencies, with paths relative to the repository root', () => {
    expect(manifest.workspace?.dependencies).toEqual([
      expect.objectContaining({ key: 'serde', version: '1', kind: 'normal' }),
      expect.objectContaining({ key: 'core', path: 'crates/core' }),
    ]);
  });

  it('keeps a workspace-only manifest free of targets and package', () => {
    expect(manifest.bins).toEqual([]);
    expect(manifest.dependencies).toEqual([]);
  });
});

describe('resolveWorkspaceInheritance', () => {
  const root = parseCargoManifest('Cargo.toml', VIRTUAL_WORKSPACE);

  it('fills inherited package fields and workspace dependencies from the root', () => {
    const member = parseCargoManifest(
      'crates/ingest/Cargo.toml',
      `
[package]
name = "ingest"
version = { workspace = true }
edition = { workspace = true }
license = { workspace = true }

[dependencies]
serde = { workspace = true, optional = true }
core = { workspace = true }
`,
    );
    const resolved = resolveWorkspaceInheritance(member, root);
    expect(resolved.problems).toEqual([]);
    expect(resolved.package).toEqual({
      name: 'ingest',
      version: '1.2.3',
      edition: '2021',
      inherits: [],
    });
    expect(resolved.dependencies).toEqual([
      expect.objectContaining({ key: 'serde', version: '1', optional: true, workspace: false }),
      expect.objectContaining({
        key: 'core',
        path: 'crates/core',
        workspace: false,
      }),
    ]);
  });

  it('reports an inherited field or dependency that the root does not provide', () => {
    const member = parseCargoManifest(
      'crates/ingest/Cargo.toml',
      `
[package]
name = "ingest"
rust-version = { workspace = true }

[dependencies]
missing = { workspace = true }
`,
    );
    const resolved = resolveWorkspaceInheritance(member, root);
    expect(resolved.problems.map((problem) => problem.message)).toEqual([
      '[package] rust-version inherits from [workspace.package], which does not set it',
      'dependency missing inherits from [workspace.dependencies], which lacks it',
    ]);
  });

  it('reports a name that tries to inherit', () => {
    const member = parseCargoManifest(
      'crates/ingest/Cargo.toml',
      '[package]\nname = { workspace = true }\n',
    );
    const resolved = resolveWorkspaceInheritance(member, root);
    expect(resolved.problems.map((problem) => problem.message)).toContain(
      '[package] name cannot inherit from the workspace',
    );
  });
});

describe('parseCargoManifest: robustness', () => {
  it('reports invalid TOML without throwing', () => {
    const manifest = parseCargoManifest('Cargo.toml', '[package\nname = "a"');
    expect(manifest.package).toBeUndefined();
    expect(manifest.problems).toHaveLength(1);
    expect(manifest.problems[0]?.path).toBe('Cargo.toml');
  });

  it('reports wrong value types and still reads the rest of the manifest', () => {
    const manifest = parseCargoManifest(
      'Cargo.toml',
      `
[package]
name = "a"
edition = 2021

[dependencies]
bad = 3
good = "1"

[bin]
name = "not-an-array"
`,
    );
    expect(manifest.package?.name).toBe('a');
    expect(manifest.package?.edition).toBeUndefined();
    expect(manifest.dependencies.map((dep) => dep.key)).toEqual(['good']);
    expect(manifest.problems.map((problem) => problem.message)).toEqual([
      '[package] edition must be a string',
      '[[bin]] must be an array of tables',
      'dependencies.bad must be a version string or a table',
    ]);
  });

  it('drops a workspace dependency that tries to inherit from itself', () => {
    const manifest = parseCargoManifest(
      'Cargo.toml',
      '[workspace]\n[workspace.dependencies]\nself = { workspace = true }\n',
    );
    expect(manifest.workspace?.dependencies).toEqual([]);
    expect(manifest.problems.map((problem) => problem.message)).toEqual([
      'workspace.dependencies.self cannot inherit from the workspace',
    ]);
  });
});
