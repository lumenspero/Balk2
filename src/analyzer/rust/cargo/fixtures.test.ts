import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { type CargoPackageDiscovery, discoverCargoPackages } from './packages.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../../test/fixtures', import.meta.url));

/** Every file under a fixture directory, as repository-relative paths with `/` separators. */
function listFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const full = join(directory, name);
    return statSync(full).isDirectory() ? listFiles(full) : [relative(FIXTURE_ROOT, full)];
  });
}

/** Runs discovery over one fixture; paths are given relative to that fixture. */
function discoverFixture(name: string): CargoPackageDiscovery {
  const base = join(FIXTURE_ROOT, name);
  const files = listFiles(base).map((file) =>
    file
      .slice(name.length + 1)
      .split(sep)
      .join('/'),
  );
  return discoverCargoPackages(files, (path) => readFileSync(join(base, path), 'utf8'));
}

describe('cargo fixtures (V3 Phase 7.2)', () => {
  it('single crate: lib, package-named bin, bin files and directories, example, test, bench, build script', () => {
    const result = discoverFixture('cargo-single');
    expect(result.problems).toEqual([]);
    expect(result.packages.map((p) => p.id)).toEqual([
      'package:cargo:.#bench:speed',
      'package:cargo:.#bin:ingest_core',
      'package:cargo:.#bin:multi',
      'package:cargo:.#bin:tool',
      'package:cargo:.#build-script:build',
      'package:cargo:.#example:demo',
      'package:cargo:.#lib:ingest_core',
      'package:cargo:.#test:it',
    ]);
    expect(result.packages.every((p) => p.edition === '2021')).toBe(true);
  });

  it('virtual workspace: members from a glob, an excluded package that is its own root', () => {
    const result = discoverFixture('cargo-virtual-workspace');
    expect(result.problems).toEqual([]);
    expect(result.packages.map((p) => [p.id, p.edition])).toEqual([
      ['package:cargo:crates/app#bin:app', '2021'],
      ['package:cargo:crates/core#lib:core_lib', '2021'],
      ['package:cargo:crates/skip#lib:skip', '2018'],
    ]);
  });

  it('renames: a renamed lib path and a renamed bin path, with the code name', () => {
    const result = discoverFixture('cargo-renames');
    expect(result.packages.map((p) => [p.id, p.roots])).toEqual([
      ['package:cargo:.#bin:cli_tool', ['src/tool/entry.rs']],
      ['package:cargo:.#lib:renamed_lib', ['src/core.rs']],
    ]);
  });

  it('custom bin path: an explicit bin replaces the inferred bin at the same path', () => {
    const result = discoverFixture('cargo-custom-bin');
    expect(result.problems).toEqual([]);
    expect(result.packages.map((p) => [p.id, p.roots])).toEqual([
      ['package:cargo:.#bin:app', ['bin/app.rs']],
      ['package:cargo:.#bin:custom_cli', ['src/main.rs']],
      ['package:cargo:.#bin:extra', ['src/bin/extra.rs']],
    ]);
  });

  it('proc-macro: the proc-macro crate is its own target kind, and its consumer is a lib', () => {
    const result = discoverFixture('cargo-proc-macro');
    expect(result.problems).toEqual([]);
    expect(result.packages.map((p) => p.id)).toEqual([
      'package:cargo:crates/consumer#lib:consumer',
      'package:cargo:crates/derive#proc-macro:my_derive',
    ]);
  });

  it('build.rs: a package with a build script, and one that disables it with build = false', () => {
    const result = discoverFixture('cargo-build-script');
    expect(result.problems).toEqual([]);
    expect(result.packages.map((p) => p.id)).toEqual([
      'package:cargo:crates/no-script#lib:no_script',
      'package:cargo:crates/with-script#build-script:build',
      'package:cargo:crates/with-script#lib:with_script',
    ]);
    expect(result.packageRoots.map((r) => r.file)).toEqual([
      'crates/no-script/src/lib.rs',
      'crates/with-script/build.rs',
      'crates/with-script/src/lib.rs',
    ]);
  });
});
