import { describe, expect, it } from 'vitest';
import { type RepositoryPackages, discoverRepositoryPackages } from './repository-packages.js';

function discover(files: Record<string, string>): RepositoryPackages {
  return discoverRepositoryPackages(Object.keys(files), (path) => files[path] ?? '');
}

describe('discoverRepositoryPackages', () => {
  it('combines the packages, roots and problems of every ecosystem', () => {
    const result = discover({
      'Cargo.toml': '[package]\nname = "tool"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/main.rs': 'fn main() {}\n',
      'package.json': '{"name":"web","main":"missing.js"}',
      'pyproject.toml': '[project]\nname = "py-tool"\n',
    });

    expect(result.packages.map((p) => p.id)).toEqual([
      'package:cargo:.#bin:tool',
      'package:npm:.',
      'package:python:.',
    ]);
    expect(result.packageRoots).toEqual([
      { packageId: 'package:cargo:.#bin:tool', file: 'src/main.rs' },
    ]);
    expect(result.problems).toEqual([
      { path: 'package.json', message: 'main entry "missing.js" has no source file' },
    ]);
  });

  it('carries cfg and implicit flags of Cargo dependencies as metadata', () => {
    const result = discover({
      'Cargo.toml': [
        '[package]',
        'name = "app"',
        'version = "0.1.0"',
        '[dependencies]',
        'helper = { path = "helper" }',
        "[target.'cfg(unix)'.dependencies]",
        'helper = { path = "helper" }',
        '',
      ].join('\n'),
      'src/lib.rs': '',
      'helper/Cargo.toml': '[package]\nname = "helper"\nversion = "0.1.0"\n',
      'helper/src/lib.rs': '',
    });
    const metadata = result.dependencies.map((d) => d.metadata);
    expect(metadata).toContainEqual({ kind: 'normal' });
    expect(metadata).toContainEqual({ kind: 'normal', cfg: 'cfg(unix)' });
  });
});
