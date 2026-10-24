import { describe, expect, it } from 'vitest';
import { PythonAnalyzer } from './index.js';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';

const META = { generatedAt: '2026-01-01T00:00:00Z' };
const KNOWN = ['app.py', 'pkg/__init__.py', 'pkg/util.py'];

function analyze(files: Record<string, string>): ConnectionMap {
  const graph = new ConnectionGraph();
  for (const [path, content] of Object.entries(files)) {
    new PythonAnalyzer().analyzeFile(path, content, graph, {
      rootDir: '.',
      knownFiles: KNOWN,
    });
  }
  return graph.build(META);
}

describe('importlib.import_module with a constant name', () => {
  it('links the importing file to the module file it names', () => {
    const map = analyze({
      'pkg/util.py': 'def help():\n    return 1\n',
      'app.py': "import importlib\n\ndef load():\n    return importlib.import_module('pkg.util')\n",
    });
    expect(map.relationships).toContainEqual(
      expect.objectContaining({
        type: 'imports',
        from: 'app.py:load',
        to: 'pkg/util.py',
        confidence: 'high',
        metadata: { loadKind: 'import-module' },
      }),
    );
  });

  it('is silent for a module that is not in the repository', () => {
    const map = analyze({
      'app.py': "import importlib\n\ndef load():\n    return importlib.import_module('requests')\n",
    });
    expect(map.relationships.filter((rel) => rel.type === 'imports')).toEqual([]);
    expect(Object.keys(map.unresolved)).toEqual([]);
  });
});

describe('importlib.import_module with a computed name', () => {
  it('reports the call as a dynamic-module-specifier observation at its line', () => {
    const map = analyze({
      'app.py': 'import importlib\n\ndef load(name):\n    return importlib.import_module(name)\n',
    });
    const observations = Object.values(map.unresolved);
    expect(observations.map((node) => node.reason)).toEqual(['dynamic-module-specifier']);
    expect(observations[0]?.location.startLine).toBe(4);
  });
});

describe('importlib.import_module forms', () => {
  it('links a from-imported import_module with a constant name', () => {
    const map = analyze({
      'pkg/util.py': 'def help():\n    return 1\n',
      'app.py':
        'from importlib import import_module\n\ndef load():\n    return import_module("pkg.util")\n',
    });
    expect(map.relationships).toContainEqual(
      expect.objectContaining({ type: 'imports', from: 'app.py:load', to: 'pkg/util.py' }),
    );
  });

  it('resolves a relative name against the package keyword', () => {
    const map = analyze({
      'pkg/util.py': 'def help():\n    return 1\n',
      'app.py':
        "import importlib\n\ndef load():\n    return importlib.import_module('.util', package='pkg')\n",
    });
    expect(map.relationships).toContainEqual(
      expect.objectContaining({ type: 'imports', from: 'app.py:load', to: 'pkg/util.py' }),
    );
  });

  it('links a package name to its __init__ file', () => {
    const map = analyze({
      'pkg/__init__.py': 'VALUE = 1\n',
      'app.py': "import importlib\n\ndef load():\n    return importlib.import_module('pkg')\n",
    });
    expect(map.relationships).toContainEqual(
      expect.objectContaining({ type: 'imports', from: 'app.py:load', to: 'pkg/__init__.py' }),
    );
  });

  it('ignores import_module called on a receiver that is not importlib', () => {
    const map = analyze({
      'pkg/util.py': 'def help():\n    return 1\n',
      'app.py':
        "class Loader:\n    def import_module(self, name):\n        return name\n\n\nloader = Loader()\n\ndef load():\n    return loader.import_module('pkg.util')\n",
    });
    expect(map.relationships.filter((rel) => rel.type === 'imports')).toEqual([]);
    expect(Object.keys(map.unresolved)).toEqual([]);
  });
});
