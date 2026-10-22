import { describe, expect, it } from 'vitest';
import { parseCargoManifest } from './manifest.js';
import { discoverTargets, type CargoTarget } from './targets.js';

/** Discovers targets for a manifest at `dir`, with `files` as the repository's files. */
function targetsOf(dir: string, manifestText: string, files: readonly string[]): CargoTarget[] {
  const path = dir === '.' ? 'Cargo.toml' : `${dir}/Cargo.toml`;
  return discoverTargets(parseCargoManifest(path, manifestText), dir, new Set(files));
}

const PACKAGE = '[package]\nname = "my-crate"\nedition = "2021"\n';

describe('discoverTargets: auto-discovery', () => {
  it('finds the lib, the package-named bin, bin files and directories, and examples, tests and benches', () => {
    const targets = targetsOf('.', PACKAGE, [
      'src/lib.rs',
      'src/main.rs',
      'src/bin/tool.rs',
      'src/bin/multi/main.rs',
      'src/bin/multi/helper.rs',
      'examples/demo.rs',
      'tests/it.rs',
      'benches/speed.rs',
    ]);
    expect(targets.map((t) => [t.id, t.root])).toEqual([
      ['package:cargo:.#lib:my_crate', 'src/lib.rs'],
      ['package:cargo:.#bin:multi', 'src/bin/multi/main.rs'],
      ['package:cargo:.#bin:my_crate', 'src/main.rs'],
      ['package:cargo:.#bin:tool', 'src/bin/tool.rs'],
      ['package:cargo:.#example:demo', 'examples/demo.rs'],
      ['package:cargo:.#test:it', 'tests/it.rs'],
      ['package:cargo:.#bench:speed', 'benches/speed.rs'],
    ]);
    expect(targets.every((t) => t.inferred)).toBe(true);
  });

  it('finds a build script at the package root and keeps build = false out', () => {
    expect(targetsOf('.', PACKAGE, ['build.rs'])).toEqual([
      expect.objectContaining({ id: 'package:cargo:.#build-script:build', root: 'build.rs' }),
    ]);
    expect(targetsOf('.', `${PACKAGE}build = false\n`, ['build.rs'])).toEqual([]);
  });

  it('uses an explicit build path', () => {
    expect(targetsOf('.', `${PACKAGE}build = "gen/make.rs"\n`, ['gen/make.rs'])).toEqual([
      expect.objectContaining({ kind: 'build-script', root: 'gen/make.rs', inferred: false }),
    ]);
  });

  it('turns off a kind of auto-discovery with its auto flag', () => {
    const targets = targetsOf('.', `${PACKAGE}autobins = false\n`, [
      'src/main.rs',
      'examples/a.rs',
    ]);
    expect(targets.map((t) => t.id)).toEqual(['package:cargo:.#example:a']);
  });

  it('reads a lib with proc-macro = true as a proc-macro target', () => {
    const targets = targetsOf('.', `${PACKAGE}\n[lib]\nproc-macro = true\n`, ['src/lib.rs']);
    expect(targets).toEqual([
      expect.objectContaining({ kind: 'proc-macro', id: 'package:cargo:.#proc-macro:my_crate' }),
    ]);
  });
});

describe('discoverTargets: explicit tables', () => {
  it('lets an explicit bin replace an inferred one with the same path', () => {
    const targets = targetsOf(
      '.',
      `${PACKAGE}\n[[bin]]\nname = "custom-cli"\npath = "src/main.rs"\n`,
      ['src/main.rs'],
    );
    expect(targets.map((t) => [t.id, t.inferred])).toEqual([
      ['package:cargo:.#bin:custom_cli', false],
    ]);
  });

  it('lets an explicit bin replace an inferred one with the same name', () => {
    const targets = targetsOf('.', `${PACKAGE}\n[[bin]]\nname = "tool"\npath = "bin/x.rs"\n`, [
      'src/bin/tool.rs',
      'bin/x.rs',
    ]);
    expect(targets.map((t) => t.id)).toEqual(['package:cargo:.#bin:tool']);
    expect(targets[0]?.root).toBe('bin/x.rs');
  });

  it('infers the path of an explicit target without one from its name', () => {
    const targets = targetsOf('.', `${PACKAGE}\n[[example]]\nname = "walk"\n`, [
      'examples/walk/main.rs',
    ]);
    expect(targets).toEqual([
      expect.objectContaining({
        id: 'package:cargo:.#example:walk',
        root: 'examples/walk/main.rs',
      }),
    ]);
  });

  it('leaves the root unset when an explicit path does not exist', () => {
    const targets = targetsOf(
      '.',
      `${PACKAGE}\n[[bin]]\nname = "gone"\npath = "bin/gone.rs"\n`,
      [],
    );
    expect(targets).toEqual([expect.objectContaining({ name: 'gone', root: undefined })]);
  });

  it('uses an explicit lib path instead of src/lib.rs', () => {
    const targets = targetsOf('.', `${PACKAGE}\n[lib]\nname = "renamed"\npath = "src/core.rs"\n`, [
      'src/lib.rs',
      'src/core.rs',
    ]);
    expect(targets).toEqual([
      expect.objectContaining({ id: 'package:cargo:.#lib:renamed', root: 'src/core.rs' }),
    ]);
  });
});

describe('discoverTargets: names and directories', () => {
  it('uses the code name, with - changed to _', () => {
    expect(targetsOf('.', PACKAGE, ['src/bin/cli-tool.rs'])).toEqual([
      expect.objectContaining({ name: 'cli_tool', id: 'package:cargo:.#bin:cli_tool' }),
    ]);
  });

  it('builds ids and roots relative to a nested package directory', () => {
    const targets = targetsOf('crates/app', PACKAGE, ['crates/app/src/main.rs', 'src/main.rs']);
    expect(targets).toEqual([
      expect.objectContaining({
        id: 'package:cargo:crates/app#bin:my_crate',
        root: 'crates/app/src/main.rs',
      }),
    ]);
  });

  it('ignores files that belong to a nested package', () => {
    const targets = targetsOf('crates/app', PACKAGE, ['crates/app/crates/inner/src/lib.rs']);
    expect(targets).toEqual([]);
  });

  it('yields nothing for a package without a name', () => {
    expect(targetsOf('.', '[package]\nedition = "2021"\n', ['src/lib.rs'])).toEqual([]);
  });
});
