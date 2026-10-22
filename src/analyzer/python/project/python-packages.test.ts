import { describe, expect, it } from 'vitest';
import { discoverPythonPackages, type PythonPackageDiscovery } from './python-packages.js';

/** Run discovery over an in-memory file set keyed by repository-relative path. */
function discover(files: Record<string, string>): PythonPackageDiscovery {
  return discoverPythonPackages(Object.keys(files), (path) => files[path] ?? '');
}

describe('discoverPythonPackages: pyproject.toml layouts', () => {
  it('reads a setuptools src layout with a script target', () => {
    const result = discover({
      'pyproject.toml': [
        '[project]',
        'name = "balk-demo"',
        '[project.scripts]',
        'demo-cli = "demo.cli:main"',
        '[tool.setuptools.packages.find]',
        'where = ["src"]',
      ].join('\n'),
    });
    expect(result.problems).toEqual([]);
    expect(result.packages).toEqual([
      {
        kind: 'package',
        id: 'package:python:.',
        ecosystem: 'python',
        name: 'balk-demo',
        target: 'lib',
        manifest: 'pyproject.toml',
        roots: ['src'],
      },
      {
        kind: 'package',
        id: 'package:python:.#script:demo-cli',
        ecosystem: 'python',
        name: 'demo-cli',
        target: 'script',
        manifest: 'pyproject.toml',
        roots: [],
      },
    ]);
  });

  it.each([
    ['setuptools package-dir', '[tool.setuptools.package-dir]\n"" = "src"', ['src']],
    ['pdm build package-dir', '[tool.pdm.build]\npackage-dir = "lib"', ['lib']],
    ['maturin python-source', '[tool.maturin]\npython-source = "python"', ['python']],
    [
      'hatch wheel packages',
      '[tool.hatch.build.targets.wheel]\npackages = ["src/pkg", "other"]',
      ['.', 'src'],
    ],
    [
      'poetry packages from',
      '[tool.poetry]\nname = "p"\npackages = [{ include = "p", from = "src" }]',
      ['src'],
    ],
  ])('reads the %s declaration', (_label, body, roots) => {
    const name = body.includes('[tool.poetry]') ? '' : '[project]\nname = "p"\n';
    const result = discover({ 'pyproject.toml': name + body });
    expect(result.problems).toEqual([]);
    expect(result.packages[0]?.roots).toEqual(roots);
  });

  it('resolves declared roots against the manifest directory', () => {
    const result = discover({
      'services/api/pyproject.toml':
        '[project]\nname = "api"\n[tool.setuptools.packages.find]\nwhere = ["src"]',
    });
    expect(result.packages[0]?.id).toBe('package:python:services/api');
    expect(result.packages[0]?.roots).toEqual(['services/api/src']);
  });

  it('gives an empty roots list when a name is declared but no layout is', () => {
    const result = discover({ 'pyproject.toml': '[project]\nname = "plain"' });
    expect(result.packages).toEqual([
      expect.objectContaining({ name: 'plain', target: 'lib', roots: [] }),
    ]);
  });

  it('treats a tool-only pyproject.toml as no package and no problem', () => {
    const result = discover({ 'pyproject.toml': '[tool.ruff]\nline-length = 100' });
    expect(result).toEqual({ packages: [], entryPoints: [], dependencies: [], problems: [] });
  });
});

describe('discoverPythonPackages: failures', () => {
  it('reports an unparseable pyproject.toml and emits no packages for it', () => {
    const result = discover({ 'pyproject.toml': '[project\nname = ' });
    expect(result.packages).toEqual([]);
    expect(result.problems).toEqual([
      expect.objectContaining({
        path: 'pyproject.toml',
        message: expect.stringContaining('cannot parse'),
      }),
    ]);
  });

  it('reports roots that have no name to attach to', () => {
    const result = discover({
      'pyproject.toml': '[tool.setuptools.packages.find]\nwhere = ["src"]',
    });
    expect(result.packages).toEqual([]);
    expect(result.problems).toEqual([
      { path: 'pyproject.toml', message: 'declares package roots or scripts but no name' },
    ]);
  });
});

describe('discoverPythonPackages: setup.cfg', () => {
  it('reads a legacy setup.cfg layout', () => {
    const result = discover({
      'setup.cfg': [
        '[metadata]',
        'name = legacy',
        '[options]',
        'package_dir =',
        '    =src',
        '[options.packages.find]',
        'where = src',
      ].join('\n'),
    });
    expect(result.problems).toEqual([]);
    expect(result.packages).toEqual([
      expect.objectContaining({
        id: 'package:python:.',
        name: 'legacy',
        manifest: 'setup.cfg',
        roots: ['src'],
      }),
    ]);
  });

  it('fills in what pyproject.toml leaves unset in the same directory', () => {
    const result = discover({
      'pyproject.toml': '[tool.ruff]\nline-length = 100\n[project]\nname = "both"',
      'setup.cfg': '[options.packages.find]\nwhere = src',
    });
    expect(result.packages[0]).toEqual(
      expect.objectContaining({ name: 'both', manifest: 'pyproject.toml', roots: ['src'] }),
    );
  });

  it('reports malformed setup.cfg lines without losing the rest of the file', () => {
    const result = discover({
      'setup.cfg': '[metadata]\nname = partial\nbroken line here',
    });
    expect(result.packages).toHaveLength(1);
    expect(result.problems).toEqual([
      { path: 'setup.cfg', message: 'line 3: expected key = value' },
    ]);
  });
});

describe('discoverPythonPackages: ordering and paths', () => {
  it('sorts packages by id and normalizes Windows separators', () => {
    // The raw list uses a backslash path. readText receives the normalized path.
    const files: Record<string, string> = {
      'tools/zeta/pyproject.toml': '[project]\nname = "zeta"',
      'alpha/pyproject.toml': '[project]\nname = "alpha"',
    };
    const result = discoverPythonPackages(
      ['tools\\zeta\\pyproject.toml', 'alpha/pyproject.toml'],
      (path) => files[path] ?? '',
    );
    expect(result.packages.map((node) => node.id)).toEqual([
      'package:python:alpha',
      'package:python:tools/zeta',
    ]);
    expect(result.packages[1]?.manifest).toBe('tools/zeta/pyproject.toml');
  });
});

describe('discoverPythonPackages: entry points', () => {
  it('keeps script targets and entry-point groups as declarations', () => {
    const result = discover({
      'pyproject.toml': [
        '[project]',
        'name = "demo"',
        '[project.scripts]',
        'demo-cli = "demo.cli:main"',
        '[project.entry-points."pytest11"]',
        'demo = "demo.plugin:Plugin [extra]"',
      ].join('\n'),
    });
    // Sorted by package id, so the distribution's entry point comes before its script node.
    expect(result.entryPoints).toEqual([
      {
        kind: 'entry-point',
        manifest: 'pyproject.toml',
        packageId: 'package:python:.',
        group: 'pytest11',
        name: 'demo',
        target: 'demo.plugin:Plugin [extra]',
      },
      {
        kind: 'script',
        manifest: 'pyproject.toml',
        packageId: 'package:python:.#script:demo-cli',
        name: 'demo-cli',
        target: 'demo.cli:main',
      },
    ]);
  });
});

describe('discoverPythonPackages: setup.py', () => {
  it('discovers a distribution from setup.py alone', () => {
    const result = discover({
      'setup.py': 'from setuptools import setup\nsetup(name="only-py", package_dir={"": "src"})',
    });
    expect(result.packages).toEqual([
      expect.objectContaining({
        id: 'package:python:.',
        name: 'only-py',
        manifest: 'setup.py',
        roots: ['src'],
      }),
    ]);
  });

  it('fills what pyproject.toml leaves unset from setup.py, and reports syntax problems', () => {
    const result = discover({
      'pyproject.toml': '[tool.ruff]\nline-length = 88\n[project]\nname = "mixed"',
      'setup.py': 'setup(packages=["mixed"])\nthis is not python ::\n',
    });
    expect(result.packages[0]).toEqual(
      expect.objectContaining({ name: 'mixed', manifest: 'pyproject.toml', roots: ['.'] }),
    );
    expect(result.problems.length).toBeGreaterThan(0);
    expect(result.problems[0]?.path).toBe('setup.py');
  });
});

describe('discoverPythonPackages: dependsOn', () => {
  /** Two distributions where `app` depends on `lib` in the given way. */
  function app(appToml: string): PythonPackageDiscovery {
    return discover({
      'lib/pyproject.toml': '[project]\nname = "shared-lib"',
      'app/pyproject.toml': `[project]\nname = "app"\n${appToml}`,
    });
  }

  it('reads a PEP 508 file reference, with ${PROJECT_ROOT} relative to the manifest', () => {
    const result = app('dependencies = ["shared-lib @ file:///${PROJECT_ROOT}/../lib"]');
    expect(result.problems).toEqual([]);
    expect(result.dependencies).toEqual([
      {
        from: 'package:python:app',
        to: 'package:python:lib',
        kind: 'normal',
        name: 'shared-lib',
        manifest: 'app/pyproject.toml',
      },
    ]);
  });

  it('reads a uv path source, and a workspace source by name', () => {
    const byPath = app(
      'dependencies = ["shared-lib"]\n[tool.uv.sources]\nshared-lib = { path = "../lib", editable = true }',
    );
    expect(byPath.dependencies.map((edge) => edge.to)).toEqual(['package:python:lib']);
    const byWorkspace = app(
      'dependencies = ["Shared_Lib"]\n[tool.uv.sources]\nshared-lib = { workspace = true }',
    );
    expect(byWorkspace.dependencies.map((edge) => edge.to)).toEqual(['package:python:lib']);
  });

  it('reads Poetry path tables and gives the kind from where the dependency is declared', () => {
    const result = discover({
      'lib/pyproject.toml': '[project]\nname = "shared-lib"',
      'app/pyproject.toml': [
        '[tool.poetry]',
        'name = "app"',
        '[tool.poetry.dependencies]',
        'shared-lib = { path = "../lib" }',
        '[tool.poetry.group.test.dependencies]',
        'shared-lib = { path = "../lib", optional = false }',
        '[tool.poetry.dev-dependencies]',
        'shared-lib = { path = "../lib" }',
      ].join('\n'),
    });
    expect(result.dependencies.map((edge) => edge.kind)).toEqual(['dev', 'normal']);
  });

  it('gives the kind for optional, dependency-group, and build requirements', () => {
    const result = app(
      [
        'optional-dependencies = { extra = ["shared-lib @ file:../lib"] }',
        '[dependency-groups]',
        'dev = ["shared-lib @ file:../lib"]',
      ].join('\n') + '\n[build-system]\nrequires = ["shared-lib @ file:../lib"]',
    );
    expect(result.dependencies.map((edge) => edge.kind)).toEqual(['build', 'dev', 'optional']);
  });

  it('reads a PDM -e file reference by its egg name', () => {
    const result = app(
      '[tool.pdm.dev-dependencies]\ntest = ["-e file:///${PROJECT_ROOT}/../lib#egg=shared-lib"]',
    );
    expect(result.dependencies).toEqual([
      expect.objectContaining({ to: 'package:python:lib', kind: 'dev', name: 'shared-lib' }),
    ]);
  });

  it('ignores absolute and external paths, and a self dependency', () => {
    const result = app('dependencies = ["shared-lib @ file:///home/someone/lib", "app @ file:."]');
    expect(result).toEqual({
      packages: expect.any(Array),
      entryPoints: [],
      dependencies: [],
      problems: [],
    });
  });

  it('reports a path that names no discovered distribution', () => {
    const result = app('dependencies = ["ghost @ file:../nowhere"]');
    expect(result.dependencies).toEqual([]);
    expect(result.problems).toEqual([
      {
        path: 'app/pyproject.toml',
        message: 'dependency "ghost" path "../nowhere" names no package',
      },
    ]);
  });
});
