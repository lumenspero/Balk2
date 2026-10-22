import { describe, expect, it } from 'vitest';
import type { PackageNode } from '../../../types.js';
import type { PythonEntryPointDeclaration } from '../project/python-packages.js';
import { createImportResolver } from './import-resolution.js';
import { ModuleIndex } from './module-index.js';
import { createSymbolResolver } from './module-exports.js';
import {
  parseEntryPointTarget,
  resolveEntryPoints,
  type EntryPointResolution,
} from './entry-points.js';

const files: Record<string, string> = {
  'src/demo/__init__.py': '',
  'src/demo/cli.py': 'def main():\n    pass\n',
  'src/demo/plugin.py': 'class Plugin:\n    pass\n',
};

const scriptNode: PackageNode = {
  kind: 'package',
  id: 'package:python:.#script:demo-cli',
  ecosystem: 'python',
  name: 'demo-cli',
  target: 'script',
  manifest: 'pyproject.toml',
  roots: [],
};

function run(
  declarations: PythonEntryPointDeclaration[],
  packages: PackageNode[] = [scriptNode],
): EntryPointResolution {
  const index = new ModuleIndex(Object.keys(files));
  const readText = (path: string): string => files[path] ?? '';
  const roots = ['src', '.'];
  const resolver = createImportResolver(index, { roots, readText });
  return resolveEntryPoints({
    packages,
    declarations,
    index,
    roots,
    symbols: createSymbolResolver({ resolver, readText }),
  });
}

describe('parseEntryPointTarget', () => {
  it('reads module, module:attribute, and drops extras', () => {
    expect(parseEntryPointTarget('pkg.mod:main')).toEqual({ module: 'pkg.mod', attribute: 'main' });
    expect(parseEntryPointTarget('pkg.mod:Cls [extra, other]')).toEqual({
      module: 'pkg.mod',
      attribute: 'Cls',
    });
    expect(parseEntryPointTarget('pkg.mod')).toEqual({ module: 'pkg.mod' });
    expect(parseEntryPointTarget('not a target')).toBeUndefined();
  });
});

describe('resolveEntryPoints', () => {
  it('gives a script node its module file, and records a packageRoot fact', () => {
    const result = run([
      {
        kind: 'script',
        manifest: 'pyproject.toml',
        packageId: scriptNode.id,
        name: 'demo-cli',
        target: 'demo.cli:main',
      },
    ]);
    expect(result.packages[0]?.roots).toEqual(['src/demo/cli.py']);
    expect(result.packageRoots).toEqual([{ packageId: scriptNode.id, file: 'src/demo/cli.py' }]);
    expect(result.problems).toEqual([]);
  });

  it('registers an entry point under its group and name, targeting the symbol', () => {
    const result = run([
      {
        kind: 'entry-point',
        manifest: 'pyproject.toml',
        packageId: 'package:python:.',
        group: 'pytest11',
        name: 'demo',
        target: 'demo.plugin:Plugin',
      },
    ]);
    expect(result.registrations).toEqual([
      {
        registryKey: 'registry:entry-points:pytest11#demo',
        manifest: 'pyproject.toml',
        target: { kind: 'symbol', id: 'src/demo/plugin.py:Plugin' },
      },
    ]);
  });

  it('treats a target outside the repository as external, without a problem', () => {
    const result = run([
      {
        kind: 'entry-point',
        manifest: 'pyproject.toml',
        packageId: 'package:python:.',
        group: 'console',
        name: 'tool',
        target: 'requests.cli:main',
      },
    ]);
    expect(result.registrations[0]?.target).toEqual({ kind: 'external', name: 'requests' });
    expect(result.problems).toEqual([]);
  });

  it('reports a repository target that does not resolve, and leaves the script without roots', () => {
    const result = run([
      {
        kind: 'script',
        manifest: 'pyproject.toml',
        packageId: scriptNode.id,
        name: 'demo-cli',
        target: 'demo.cli:missing',
      },
    ]);
    expect(result.packages[0]?.roots).toEqual(['src/demo/cli.py']);
    expect(result.problems).toEqual([
      {
        path: 'pyproject.toml',
        message: 'script "demo-cli" target "demo.cli:missing" does not resolve',
      },
    ]);
  });

  it('reports a malformed target as a problem', () => {
    const result = run([
      {
        kind: 'script',
        manifest: 'pyproject.toml',
        packageId: scriptNode.id,
        name: 'demo-cli',
        target: 'not a target',
      },
    ]);
    expect(result.problems).toEqual([
      {
        path: 'pyproject.toml',
        message: 'script "demo-cli" has an invalid target "not a target"',
      },
    ]);
  });
});
