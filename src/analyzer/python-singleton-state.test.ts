import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectionGraph } from '../cli/build-graph.js';
import type { Balk2Config } from '../config/config.js';
import type { ConnectionMap } from '../types.js';

// Each case analyzes a repository on disk, so keep the default 5s limit out of the way.
vi.setConfig({ testTimeout: 60_000 });

const SINGLETON: Balk2Config = {
  state: { singletons: [{ module: 'store.py', export: 'store' }] },
} as unknown as Balk2Config;

/** Writes the files to a temporary repository and returns the connection map. */
function mapOf(files: Record<string, string>, config: Balk2Config = SINGLETON): ConnectionMap {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-py-singleton-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(rootDir, name)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, name), content, 'utf8');
    }
    return buildConnectionGraph(rootDir, config).build({
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

const STORE = 'store = None\n';

describe('python configured singletons (V3 Phase 12.3)', () => {
  it('writes a field of a singleton imported by name', () => {
    const map = mapOf({
      'store.py': STORE,
      'main.py': 'from store import store\n\n\ndef set_it():\n    store.count = 2\n',
    });

    expect(stateEdges(map)).toEqual(['writesState main.py:set_it -> state:store.py:store#count']);
  });

  it('follows an aliased import, and reads and writes a compound assignment', () => {
    const map = mapOf({
      'store.py': STORE,
      'main.py': 'from store import store as s\n\n\ndef bump():\n    s.count += 1\n',
    });

    expect(stateEdges(map)).toEqual([
      'readsState main.py:bump -> state:store.py:store#count',
      'writesState main.py:bump -> state:store.py:store#count',
    ]);
  });

  it('records a static field path below the singleton', () => {
    const map = mapOf({
      'store.py': STORE,
      'main.py': 'from store import store\n\n\ndef set_it():\n    store.stats.hits = 1\n',
    });

    expect(stateEdges(map)).toEqual([
      'writesState main.py:set_it -> state:store.py:store#stats.hits',
    ]);
  });

  it('gives no state for a singleton that is not configured', () => {
    const map = mapOf(
      {
        'store.py': STORE,
        'main.py': 'from store import store\n\n\ndef set_it():\n    store.count = 2\n',
      },
      {} as Balk2Config,
    );

    expect(stateEdges(map)).toEqual([]);
  });

  it('gives no state for a name imported from another module', () => {
    const map = mapOf({
      'store.py': STORE,
      'other.py': 'store = None\n',
      'main.py': 'from other import store\n\n\ndef set_it():\n    store.count = 2\n',
    });

    expect(stateEdges(map)).toEqual([]);
  });

  it('gives no state for a path through a module that is not a singleton', () => {
    const map = mapOf({
      'store.py': STORE,
      'main.py': 'import store\n\n\ndef set_it():\n    store.store.count = 2\n',
    });

    expect(stateEdges(map)).toEqual([]);
  });
});
