import { describe, expect, it } from 'vitest';
import { PythonAnalyzer } from './index.js';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';

const META = { generatedAt: '2026-01-01T00:00:00Z' };

/** Analyzes each file, with every file in the map known to the repository. */
function analyze(files: Record<string, string>): ConnectionMap {
  const graph = new ConnectionGraph();
  const knownFiles = Object.keys(files);
  for (const [path, content] of Object.entries(files)) {
    new PythonAnalyzer().analyzeFile(path, content, graph, { rootDir: '.', knownFiles });
  }
  return graph.build(META);
}

const imports = (map: ConnectionMap): ConnectionMap['relationships'] =>
  map.relationships.filter((rel) => rel.type === 'imports');

describe('__import__', () => {
  it('links a literal absolute name to the module it names', () => {
    const map = analyze({
      'pkg/util.py': 'def help():\n    return 1\n',
      'app.py': "def load():\n    return __import__('pkg.util')\n",
    });
    expect(imports(map)).toContainEqual(
      expect.objectContaining({
        from: 'app.py:load',
        to: 'pkg/util.py',
        metadata: { loadKind: 'dunder-import' },
      }),
    );
  });

  it('resolves a level-1 name against the importing file package', () => {
    const map = analyze({
      'pkg/util.py': 'def help():\n    return 1\n',
      'pkg/app.py': "def load():\n    return __import__('util', globals(), None, None, 1)\n",
    });
    expect(imports(map)).toContainEqual(
      expect.objectContaining({ from: 'pkg/app.py:load', to: 'pkg/util.py' }),
    );
  });

  it('reports a computed name as a dynamic-module-specifier observation', () => {
    const map = analyze({
      'app.py': 'def load(name):\n    return __import__(name)\n',
    });
    expect(Object.values(map.unresolved).map((node) => node.reason)).toEqual([
      'dynamic-module-specifier',
    ]);
  });

  it('is silent when a repository function of that name shadows the builtin', () => {
    const map = analyze({
      'pkg/util.py': 'def help():\n    return 1\n',
      'app.py':
        "def __import__(name):\n    return name\n\n\ndef load():\n    return __import__('pkg.util')\n",
    });
    expect(imports(map)).toEqual([]);
    expect(Object.keys(map.unresolved)).toEqual([]);
  });
});

describe('runpy', () => {
  it('links run_module with a literal module name', () => {
    const map = analyze({
      'pkg/util.py': 'def help():\n    return 1\n',
      'app.py': "import runpy\n\ndef load():\n    runpy.run_module('pkg.util', run_name='x')\n",
    });
    expect(imports(map)).toContainEqual(
      expect.objectContaining({
        from: 'app.py:load',
        to: 'pkg/util.py',
        metadata: { loadKind: 'run-module' },
      }),
    );
  });

  it('links run_path with a literal repository path, including a from-import', () => {
    const map = analyze({
      'scripts/tool.py': 'print(1)\n',
      'app.py':
        "import runpy\nfrom runpy import run_path\n\ndef load():\n    runpy.run_path('scripts/tool.py')\n\ndef again():\n    run_path('scripts/tool.py')\n",
    });
    expect(imports(map)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'app.py:load',
          to: 'scripts/tool.py',
          metadata: { loadKind: 'run-path' },
        }),
        expect.objectContaining({
          from: 'app.py:again',
          to: 'scripts/tool.py',
          metadata: { loadKind: 'run-path' },
        }),
      ]),
    );
  });
});

describe('importlib.util.spec_from_file_location', () => {
  it('links a literal repository path', () => {
    const map = analyze({
      'plugins/alpha.py': 'VALUE = 1\n',
      'app.py':
        "import importlib.util\n\ndef load():\n    return importlib.util.spec_from_file_location('alpha', 'plugins/alpha.py')\n",
    });
    expect(imports(map)).toContainEqual(
      expect.objectContaining({
        from: 'app.py:load',
        to: 'plugins/alpha.py',
        metadata: { loadKind: 'spec-from-file' },
      }),
    );
  });

  it('reports a computed path as a dynamic-module-specifier observation', () => {
    const map = analyze({
      'app.py':
        "import importlib.util\n\ndef load(path):\n    return importlib.util.spec_from_file_location('alpha', path)\n",
    });
    expect(Object.values(map.unresolved).map((node) => node.reason)).toEqual([
      'dynamic-module-specifier',
    ]);
  });
});
