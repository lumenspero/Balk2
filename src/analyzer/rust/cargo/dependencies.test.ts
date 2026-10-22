import { describe, expect, it } from 'vitest';
import type { CargoPackageDependency } from './dependencies.js';
import { type CargoPackageDiscovery, discoverCargoPackages } from './packages.js';

/** Runs discovery over an in-memory repository: `files` maps each path to its contents. */
function discover(files: Record<string, string>): CargoPackageDiscovery {
  return discoverCargoPackages(Object.keys(files), (path) => files[path] ?? '');
}

/** One line per edge, sorted, so that assertions do not depend on edge order. */
function lines(edges: readonly CargoPackageDependency[]): string[] {
  return edges
    .map(
      (edge) =>
        `${edge.from} -> ${edge.to} [${edge.kind}] ${edge.name}` +
        `${edge.cfg === undefined ? '' : ` cfg=${edge.cfg}`}${edge.implicit ? ' implicit' : ''}`,
    )
    .sort();
}

const WORKSPACE = '[workspace]\nmembers = ["crates/*"]\n';
const CORE = {
  'crates/core/Cargo.toml': '[package]\nname = "core-lib"\nedition = "2021"\n',
  'crates/core/src/lib.rs': '',
};

describe('cargo dependsOn edges (V3 Phase 7.3)', () => {
  it('normal path dependency: every non-build target depends on the library, plus implicit edges', () => {
    const result = discover({
      'Cargo.toml': WORKSPACE,
      'crates/app/Cargo.toml':
        '[package]\nname = "app"\n[dependencies]\ncore-lib = { path = "../core" }\n',
      'crates/app/src/main.rs': '',
      'crates/app/src/lib.rs': '',
      ...CORE,
    });
    expect(result.problems).toEqual([]);
    expect(lines(result.dependencies)).toEqual([
      'package:cargo:crates/app#bin:app -> package:cargo:crates/app#lib:app [normal] app implicit',
      'package:cargo:crates/app#bin:app -> package:cargo:crates/core#lib:core_lib [normal] core_lib',
      'package:cargo:crates/app#lib:app -> package:cargo:crates/core#lib:core_lib [normal] core_lib',
    ]);
  });

  it('dev dependency: only tests, examples and benches see it', () => {
    const result = discover({
      'Cargo.toml': WORKSPACE,
      'crates/app/Cargo.toml':
        '[package]\nname = "app"\n[dev-dependencies]\ncore-lib = { path = "../core" }\n',
      'crates/app/src/lib.rs': '',
      'crates/app/src/main.rs': '',
      'crates/app/tests/it.rs': '',
      'crates/app/examples/demo.rs': '',
      ...CORE,
    });
    expect(lines(result.dependencies).filter((line) => line.includes('[dev]'))).toEqual([
      'package:cargo:crates/app#example:demo -> package:cargo:crates/core#lib:core_lib [dev] core_lib',
      'package:cargo:crates/app#test:it -> package:cargo:crates/core#lib:core_lib [dev] core_lib',
    ]);
    expect(result.dependencies.some((edge) => edge.from.includes('#lib:app'))).toBe(false);
  });

  it('build dependency: only the build script sees it', () => {
    const result = discover({
      'Cargo.toml': WORKSPACE,
      'crates/app/Cargo.toml':
        '[package]\nname = "app"\n[build-dependencies]\ncore-lib = { path = "../core" }\n',
      'crates/app/build.rs': '',
      'crates/app/src/lib.rs': '',
      ...CORE,
    });
    expect(lines(result.dependencies)).toEqual([
      'package:cargo:crates/app#build-script:build -> package:cargo:crates/core#lib:core_lib [build] core_lib',
    ]);
  });

  it('optional dependency in a target table: kind optional, with the cfg kept', () => {
    const result = discover({
      'Cargo.toml': WORKSPACE,
      'crates/app/Cargo.toml':
        '[package]\nname = "app"\n[target.\'cfg(unix)\'.dependencies]\ncore-lib = { path = "../core", optional = true }\n',
      'crates/app/src/lib.rs': '',
      ...CORE,
    });
    expect(lines(result.dependencies)).toEqual([
      'package:cargo:crates/app#lib:app -> package:cargo:crates/core#lib:core_lib [optional] core_lib cfg=cfg(unix)',
    ]);
  });

  it('a renamed dependency is named by its key, with - changed to _', () => {
    const result = discover({
      'Cargo.toml': WORKSPACE,
      'crates/app/Cargo.toml':
        '[package]\nname = "app"\n[dependencies]\nmy-alias = { package = "core-lib", path = "../core" }\n',
      'crates/app/src/lib.rs': '',
      ...CORE,
    });
    expect(lines(result.dependencies)).toEqual([
      'package:cargo:crates/app#lib:app -> package:cargo:crates/core#lib:core_lib [normal] my_alias',
    ]);
  });

  it('a workspace dependency copies its path from the root, which is not joined again', () => {
    const result = discover({
      'Cargo.toml':
        '[workspace]\nmembers = ["crates/*"]\n[workspace.dependencies]\ncore = { path = "crates/core" }\n',
      'crates/app/Cargo.toml':
        '[package]\nname = "app"\n[dependencies]\ncore = { workspace = true }\n',
      'crates/app/src/lib.rs': '',
      ...CORE,
    });
    expect(result.problems).toEqual([]);
    expect(lines(result.dependencies)).toEqual([
      'package:cargo:crates/app#lib:app -> package:cargo:crates/core#lib:core_lib [normal] core',
    ]);
  });

  it('registry, git and outside-path dependencies become externs, not edges', () => {
    const result = discover({
      'Cargo.toml': WORKSPACE,
      'crates/app/Cargo.toml': [
        '[package]',
        'name = "app"',
        '[dependencies]',
        'serde = "1"',
        'git-dep = { git = "https://example.com/x.git" }',
        'outside = { path = "../../../elsewhere" }',
        '[dev-dependencies]',
        'tempfile = "3"',
        '',
      ].join('\n'),
      'crates/app/src/lib.rs': '',
    });
    expect(result.dependencies).toEqual([]);
    expect(result.externs).toEqual([
      {
        manifest: 'crates/app/Cargo.toml',
        name: 'git_dep',
        kind: 'normal',
        source: 'git',
      },
      {
        manifest: 'crates/app/Cargo.toml',
        name: 'outside',
        kind: 'normal',
        source: 'path',
      },
      {
        manifest: 'crates/app/Cargo.toml',
        name: 'serde',
        kind: 'normal',
        source: 'registry',
      },
      {
        manifest: 'crates/app/Cargo.toml',
        name: 'tempfile',
        kind: 'dev',
        source: 'registry',
      },
    ]);
  });

  it('a path dependency that names no library is a problem, with no edge', () => {
    const result = discover({
      'Cargo.toml': WORKSPACE,
      'crates/app/Cargo.toml':
        '[package]\nname = "app"\n[dependencies]\nbin-only = { path = "../tool" }\nnothing = { path = "../missing" }\n',
      'crates/app/src/lib.rs': '',
      'crates/tool/Cargo.toml': '[package]\nname = "tool"\n',
      'crates/tool/src/main.rs': '',
    });
    expect(result.dependencies.filter((edge) => edge.kind === 'normal' && !edge.implicit)).toEqual(
      [],
    );
    expect(result.problems.map((problem) => problem.message)).toEqual([
      'path dependency "bin-only" at "crates/tool" names no package with a library target',
      'path dependency "nothing" at "crates/missing" names no package with a library target',
    ]);
  });

  it('a dependency edge runs to a proc-macro library too', () => {
    const result = discover({
      'Cargo.toml': WORKSPACE,
      'crates/derive/Cargo.toml': '[package]\nname = "my-derive"\n[lib]\nproc-macro = true\n',
      'crates/derive/src/lib.rs': '',
      'crates/app/Cargo.toml':
        '[package]\nname = "app"\n[dependencies]\nmy-derive = { path = "../derive" }\n',
      'crates/app/src/lib.rs': '',
    });
    expect(lines(result.dependencies)).toEqual([
      'package:cargo:crates/app#lib:app -> package:cargo:crates/derive#proc-macro:my_derive [normal] my_derive',
    ]);
  });
});
