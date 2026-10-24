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
function mapOf(files: Record<string, string>): ConnectionMap {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-py-cross-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(rootDir, name)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, name), content, 'utf8');
    }
    return buildConnectionGraph(rootDir, {} as Balk2Config).build({
      generatedAt: '2026-01-01T00:00:00Z',
    });
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

/** The state relationships as `type from -> to`, sorted, for readable assertions. */
function stateEdges(map: ConnectionMap): string[] {
  return map.relationships
    .filter((r) => r.type === 'readsState' || r.type === 'writesState')
    .map((r) => `${r.type} ${r.from} -> ${r.to}`)
    .sort();
}

const STORE = 'count = 0\n';

describe('python module attributes written from another module (V3 Phase 12.3)', () => {
  it('writes the module global of an imported module', () => {
    const map = mapOf({
      'store.py': STORE,
      'main.py': 'import store\n\n\ndef set_it():\n    store.count = 2\n',
    });

    expect(stateEdges(map)).toEqual(['writesState main.py:set_it -> state:store.py:count']);
  });

  it('follows an aliased import, and reads and writes a compound assignment', () => {
    const map = mapOf({
      'store.py': STORE,
      'main.py': 'import store as s\n\n\ndef bump():\n    s.count += 1\n',
    });

    expect(stateEdges(map)).toEqual([
      'readsState main.py:bump -> state:store.py:count',
      'writesState main.py:bump -> state:store.py:count',
    ]);
  });

  it('writes through a submodule bound by from-import', () => {
    const map = mapOf({
      'pkg/__init__.py': '',
      'pkg/store.py': STORE,
      'main.py': 'from pkg import store\n\n\ndef set_it():\n    store.count = 2\n',
    });

    expect(stateEdges(map)).toEqual(['writesState main.py:set_it -> state:pkg/store.py:count']);
  });

  it('writes a builtins attribute to the global root', () => {
    const map = mapOf({
      'main.py': 'import builtins\n\n\ndef patch():\n    builtins.answer = 42\n',
    });

    expect(stateEdges(map)).toEqual(['writesState main.py:patch -> state:global#answer']);
  });

  it('gives no state for an attribute of a class or of a name that is not an import', () => {
    const map = mapOf({
      'store.py': 'class Config:\n    pass\n',
      'main.py':
        'from store import Config\n\n\ndef set_it():\n    Config.count = 2\n\n\ndef other():\n    unknown.count = 3\n',
    });

    expect(stateEdges(map)).toEqual([]);
  });
});
