import { describe, expect, it } from 'vitest';
import { type RepositoryPackages, discoverRepositoryPackages } from './repository-packages.js';

function discover(files: Record<string, string>): RepositoryPackages {
  return discoverRepositoryPackages(Object.keys(files), (path) => files[path] ?? '');
}

const helperCrate = {
  'helper/Cargo.toml': '[package]\nname = "helper"\nversion = "0.1.0"\n',
  'helper/src/lib.rs': '',
};

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

  it('keeps cfg on a dependency that only one target table declares', () => {
    const result = discover({
      'Cargo.toml':
        '[package]\nname = "app"\nversion = "0.1.0"\n[target.\'cfg(unix)\'.dependencies]\nhelper = { path = "helper" }\n',
      'src/lib.rs': '',
      ...helperCrate,
    });
    expect(result.dependencies.map((d) => d.metadata)).toEqual([
      { kind: 'normal', cfg: 'cfg(unix)' },
    ]);
  });

  it('drops cfg when the same dependency is also declared without one', () => {
    const result = discover({
      'Cargo.toml':
        '[package]\nname = "app"\nversion = "0.1.0"\n[dependencies]\nhelper = { path = "helper" }\n[target.\'cfg(unix)\'.dependencies]\nhelper = { path = "helper" }\n',
      'src/lib.rs': '',
      ...helperCrate,
    });
    expect(result.dependencies.map((d) => d.metadata)).toEqual([{ kind: 'normal' }]);
  });

  it('keeps the most production-relevant kind when a pair is declared twice', () => {
    const result = discover({
      'package.json': '{"workspaces":["packages/*"]}',
      'packages/a/package.json':
        '{"name":"a","devDependencies":{"b":"workspace:*"},"dependencies":{"b":"workspace:*"}}',
      'packages/b/package.json': '{"name":"b","version":"1.0.0"}',
    });
    expect(result.dependencies.map((d) => [d.from, d.to, d.metadata])).toEqual([
      ['package:npm:packages/a', 'package:npm:packages/b', { kind: 'normal' }],
    ]);
  });

  it('reports a manifest that cannot be read, and leaves its package out', () => {
    const files: Record<string, string> = {
      'package.json': '{"name":"root"}',
      'packages/bad/package.json': '{"name":"bad"}',
    };
    const result = discoverRepositoryPackages(Object.keys(files), (path) => {
      if (path === 'packages/bad/package.json') throw new Error('EACCES: permission denied');
      return files[path] ?? '';
    });
    expect(result.packages.map((p) => p.id)).toEqual(['package:npm:.']);
    expect(result.problems).toEqual([
      {
        path: 'packages/bad/package.json',
        message: 'manifest cannot be read: EACCES: permission denied',
      },
    ]);
  });
});
