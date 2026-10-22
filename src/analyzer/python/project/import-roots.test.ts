import { describe, expect, it } from 'vitest';
import type { PackageNode } from '../../../types.js';
import { resolveImportRoots, scriptDirectoryRoot, type ImportRootInput } from './import-roots.js';

function lib(manifest: string, roots: string[]): PackageNode {
  return {
    kind: 'package',
    id: `package:python:${manifest.replace(/\/?pyproject\.toml$/, '') || '.'}`,
    ecosystem: 'python',
    name: 'demo',
    target: 'lib',
    manifest,
    roots,
  };
}

function input(overrides: Partial<ImportRootInput>): ImportRootInput {
  return { configured: [], packages: [], filePaths: ['main.py'], ...overrides };
}

describe('resolveImportRoots precedence', () => {
  it('orders configured, manifest, src layout, then the repository root', () => {
    const result = resolveImportRoots(
      input({
        configured: ['lib'],
        packages: [lib('pyproject.toml', ['pkgs'])],
        filePaths: ['lib/a.py', 'pkgs/b.py', 'src/c.py', 'main.py'],
      }),
    );
    expect(result.problems).toEqual([]);
    expect(result.roots).toEqual([
      { path: 'lib', source: 'config' },
      { path: 'pkgs', source: 'manifest', manifest: 'pyproject.toml' },
      { path: 'src', source: 'src-layout' },
      { path: '.', source: 'repository' },
    ]);
  });

  it('keeps the highest-precedence source when two sources name one directory', () => {
    const result = resolveImportRoots(
      input({
        configured: ['./src/'],
        packages: [lib('pyproject.toml', ['src'])],
        filePaths: ['src/a.py'],
      }),
    );
    expect(result.roots).toEqual([
      { path: 'src', source: 'config' },
      { path: '.', source: 'repository' },
    ]);
  });

  it('always ends with the repository root, even with no Python files', () => {
    const result = resolveImportRoots(input({ filePaths: ['README.md'] }));
    expect(result.roots).toEqual([{ path: '.', source: 'repository' }]);
  });

  it('adds a src root only when a Python file sits under src/', () => {
    const withoutPython = resolveImportRoots(input({ filePaths: ['src/notes.txt', 'main.py'] }));
    expect(withoutPython.roots.map((root) => root.source)).toEqual(['repository']);

    const withStub = resolveImportRoots(input({ filePaths: ['src/pkg/__init__.pyi'] }));
    expect(withStub.roots.map((root) => root.source)).toEqual(['src-layout', 'repository']);
  });
});

describe('resolveImportRoots problems and normalization', () => {
  it('drops a declared root with no scanned files and reports it', () => {
    const result = resolveImportRoots(
      input({ configured: ['missing'], packages: [lib('pkg/pyproject.toml', ['pkg/src'])] }),
    );
    expect(result.roots).toEqual([{ path: '.', source: 'repository' }]);
    expect(result.problems).toEqual([
      { path: 'missing', message: 'config import root "missing" names no scanned files' },
      {
        path: 'pkg/pyproject.toml',
        message: 'manifest import root "pkg/src" names no scanned files',
      },
    ]);
  });

  it('normalizes Windows separators in configured and scanned paths', () => {
    const result = resolveImportRoots(
      input({ configured: ['lib\\core'], filePaths: ['lib\\core\\x.py'] }),
    );
    expect(result.roots[0]).toEqual({ path: 'lib/core', source: 'config' });
  });

  it('ignores non-library packages and script nodes', () => {
    const script: PackageNode = {
      kind: 'package',
      id: 'package:python:.#script:tool',
      ecosystem: 'python',
      name: 'tool',
      target: 'script',
      manifest: 'pyproject.toml',
      roots: ['tools'],
    };
    const result = resolveImportRoots(input({ packages: [script], filePaths: ['tools/t.py'] }));
    expect(result.roots.map((root) => root.path)).toEqual(['.']);
  });
});

describe('scriptDirectoryRoot', () => {
  it('gives the directory of the script as a root fact', () => {
    expect(scriptDirectoryRoot('scripts/collect.py')).toEqual({
      path: 'scripts',
      source: 'script-directory',
    });
    expect(scriptDirectoryRoot('run.py')).toEqual({ path: '.', source: 'script-directory' });
  });
});
