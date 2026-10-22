import { describe, expect, it } from 'vitest';
import { type CargoPackageDiscovery, discoverCargoPackages } from './packages.js';

/** Runs discovery over an in-memory repository: `files` maps each path to its contents. */
function discover(files: Record<string, string>): CargoPackageDiscovery {
  return discoverCargoPackages(Object.keys(files), (path) => files[path] ?? '');
}

describe('discoverCargoPackages', () => {
  it('emits one package node per target, with the manifest, roots and edition', () => {
    const result = discover({
      'crates/app/Cargo.toml': '[package]\nname = "app"\nedition = "2021"\n',
      'crates/app/src/main.rs': '',
      'crates/app/src/lib.rs': '',
    });
    expect(result.problems).toEqual([]);
    expect(result.packages).toEqual([
      {
        kind: 'package',
        id: 'package:cargo:crates/app#bin:app',
        ecosystem: 'cargo',
        name: 'app',
        target: 'bin',
        manifest: 'crates/app/Cargo.toml',
        roots: ['crates/app/src/main.rs'],
        edition: '2021',
      },
      {
        kind: 'package',
        id: 'package:cargo:crates/app#lib:app',
        ecosystem: 'cargo',
        name: 'app',
        target: 'lib',
        manifest: 'crates/app/Cargo.toml',
        roots: ['crates/app/src/lib.rs'],
        edition: '2021',
      },
    ]);
    expect(result.packageRoots).toEqual([
      { packageId: 'package:cargo:crates/app#bin:app', file: 'crates/app/src/main.rs' },
      { packageId: 'package:cargo:crates/app#lib:app', file: 'crates/app/src/lib.rs' },
    ]);
  });

  it('defaults the edition to 2015 and emits no packageRoot for a missing file', () => {
    const result = discover({
      'Cargo.toml': '[package]\nname = "old"\n[[bin]]\nname = "gone"\npath = "bin/gone.rs"\n',
    });
    expect(result.packages.map((p) => [p.id, p.roots, p.edition])).toEqual([
      ['package:cargo:.#bin:gone', [], '2015'],
    ]);
    expect(result.packageRoots).toEqual([]);
  });

  it('emits no package nodes for a virtual manifest, but keeps it as a manifest', () => {
    const result = discover({ 'Cargo.toml': '[workspace]\nmembers = []\n' });
    expect(result.packages).toEqual([]);
    expect(result.manifests.map((m) => m.path)).toEqual(['Cargo.toml']);
  });

  it('resolves members against their workspace root and expands globs', () => {
    const result = discover({
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n[workspace.package]\nedition = "2021"\n',
      'crates/core/Cargo.toml': '[package]\nname = "core"\nedition = { workspace = true }\n',
      'crates/core/src/lib.rs': '',
      'crates/other/Cargo.toml': '[package]\nname = "other"\n',
      'crates/other/src/lib.rs': '',
    });
    expect(result.problems).toEqual([]);
    expect(result.packages.map((p) => [p.id, p.edition])).toEqual([
      ['package:cargo:crates/core#lib:core', '2021'],
      ['package:cargo:crates/other#lib:other', '2015'],
    ]);
  });

  it('reports a package inside a workspace that does not list it, and leaves it uninherited', () => {
    const result = discover({
      'Cargo.toml': '[workspace]\nmembers = ["crates/a"]\n',
      'crates/b/Cargo.toml': '[package]\nname = "b"\nversion = { workspace = true }\n',
    });
    expect(result.problems.map((p) => p.message)).toEqual([
      'package is inside the workspace at . but is not one of its members',
      '[package] version inherits from [workspace.package], which does not set it',
    ]);
  });

  it('lets a nested workspace root own its own members', () => {
    const result = discover({
      'Cargo.toml': '[workspace]\nmembers = ["tools/*"]\n',
      'tools/Cargo.toml': '[workspace]\nmembers = ["cli"]\n',
      'tools/cli/Cargo.toml': '[package]\nname = "cli"\n',
      'tools/cli/src/main.rs': '',
    });
    expect(result.problems).toEqual([]);
    expect(result.packages.map((p) => p.id)).toEqual(['package:cargo:tools/cli#bin:cli']);
  });

  it('keeps one node when two manifests would yield the same target id', () => {
    const result = discover({
      'Cargo.toml':
        '[package]\nname = "dup"\n[[bin]]\nname = "x"\npath = "a.rs"\n[[bin]]\nname = "x"\npath = "b.rs"\n',
      'a.rs': '',
      'b.rs': '',
    });
    expect(result.packages.map((p) => p.id)).toEqual(['package:cargo:.#bin:x']);
    expect(result.packages[0]?.roots).toEqual(['a.rs']);
  });

  it('keeps manifest problems from parsing', () => {
    const result = discover({ 'Cargo.toml': '[package\n' });
    expect(result.problems).toHaveLength(1);
    expect(result.packages).toEqual([]);
  });

  it('sorts packages by id and roots by package then file', () => {
    const result = discover({
      'b/Cargo.toml': '[package]\nname = "b"\n',
      'b/src/lib.rs': '',
      'a/Cargo.toml': '[package]\nname = "a"\n',
      'a/src/lib.rs': '',
    });
    expect(result.packages.map((p) => p.id)).toEqual([
      'package:cargo:a#lib:a',
      'package:cargo:b#lib:b',
    ]);
    expect(result.packageRoots.map((r) => r.packageId)).toEqual([
      'package:cargo:a#lib:a',
      'package:cargo:b#lib:b',
    ]);
  });
});
