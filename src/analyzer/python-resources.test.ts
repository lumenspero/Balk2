import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectionGraph } from '../cli/build-graph.js';
import type { Balk2Config } from '../config/config.js';
import type { ConnectionMap } from '../types.js';

// Each case analyzes a repository on disk, so keep the default 5s limit out of the way.
vi.setConfig({ testTimeout: 60_000 });

/** Writes the files to a temporary repository and returns the connection map. */
function mapOf(files: Record<string, string>, config: Partial<Balk2Config> = {}): ConnectionMap {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-python-resources-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(rootDir, name)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, name), content, 'utf8');
    }
    return buildConnectionGraph(rootDir, config as Balk2Config).build({
      generatedAt: '2026-01-01T00:00:00Z',
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

/** The resource usages as `from -> resource (mechanism)`, sorted, for readable assertions. */
function usages(map: ConnectionMap): string[] {
  return map.relationships
    .filter((rel) => rel.type === 'usesResource')
    .map(
      (rel) =>
        `${rel.from} -> ${rel.to.replace(/^resource:/, '')} (${String(rel.metadata?.['mechanism'])})`,
    )
    .sort();
}

const PKG = { 'app/__init__.py': '', 'app/templates/card.html': '<p>card</p>\n' };

describe('python resource reads through importlib.resources and pkgutil (V3 Phase 12.6)', () => {
  it('links a files() chain joined with / and read with read_text', () => {
    const map = mapOf({
      ...PKG,
      'app/main.py':
        "import importlib.resources\n\n\ndef load():\n    return (importlib.resources.files('app') / 'templates/card.html').read_text()\n",
    });
    expect(usages(map)).toEqual(['app/main.py:load -> app/templates/card.html (api)']);
  });

  it('links a files() chain joined with joinpath and read with open_text', () => {
    const map = mapOf({
      ...PKG,
      'app/main.py':
        "from importlib.resources import files\n\n\ndef load():\n    return files('app').joinpath('templates', 'card.html').open_text()\n",
    });
    expect(usages(map)).toEqual(['app/main.py:load -> app/templates/card.html (api)']);
  });

  it('links the function API read_text with a package and a resource name', () => {
    const map = mapOf({
      ...PKG,
      'app/main.py':
        "import importlib.resources\n\n\ndef load():\n    return importlib.resources.read_text('app', 'templates/card.html')\n",
    });
    expect(usages(map)).toEqual(['app/main.py:load -> app/templates/card.html (api)']);
  });

  it('links pkgutil.get_data with a package and a resource path', () => {
    const map = mapOf({
      ...PKG,
      'app/main.py':
        "import pkgutil\n\n\ndef load():\n    return pkgutil.get_data('app', 'templates/card.html')\n",
    });
    expect(usages(map)).toEqual(['app/main.py:load -> app/templates/card.html (api)']);
  });

  it('is silent for a resource that the repository does not hold', () => {
    const map = mapOf({
      ...PKG,
      'app/main.py':
        "import importlib.resources\n\n\ndef load():\n    return importlib.resources.read_text('app', 'missing.html')\n",
    });
    expect(usages(map)).toEqual([]);
    expect(Object.keys(map.unresolved)).toEqual([]);
  });

  it('reports a computed package as a dynamic-resource-specifier observation', () => {
    const map = mapOf({
      ...PKG,
      'app/main.py':
        "import importlib.resources\n\n\ndef load(name):\n    return importlib.resources.read_text(name, 'card.html')\n",
    });
    expect(Object.values(map.unresolved).map((node) => node.reason)).toEqual([
      'dynamic-resource-specifier',
    ]);
  });

  it('links a configured loader call such as get_template, with the loader mechanism', () => {
    const map = mapOf(
      {
        'templates/card.html': '<p>card</p>\n',
        'app/render.py': "def render(env):\n    return env.get_template('templates/card.html')\n",
      },
      {
        protocols: { resources: [{ function: 'get_template', specifierArg: 0 }] },
      } as unknown as Partial<Balk2Config>,
    );
    expect(usages(map)).toEqual(['app/render.py:render -> templates/card.html (loader)']);
  });
});
