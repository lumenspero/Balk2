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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-python-state-'));
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

describe('python module globals as shared state (V3 Phase 12.3)', () => {
  it('writes a module global that a function assigns through global', () => {
    const map = mapOf({
      'store.py': 'count = 0\n\n\ndef set_count(value):\n    global count\n    count = value\n',
    });

    expect(stateEdges(map)).toEqual(['writesState store.py:set_count -> state:store.py:count']);
  });

  it('reads and writes a compound assignment through global', () => {
    const map = mapOf({
      'store.py': 'count = 0\n\n\ndef bump():\n    global count\n    count += 1\n',
    });

    expect(stateEdges(map)).toEqual([
      'readsState store.py:bump -> state:store.py:count',
      'writesState store.py:bump -> state:store.py:count',
    ]);
  });

  it('gives no state for a local that shadows a global without a global statement', () => {
    const map = mapOf({
      'store.py': 'count = 0\n\n\ndef local():\n    count = 5\n    return count\n',
    });

    expect(stateEdges(map)).toEqual([]);
  });

  // Known gap: a read of a global that no function writes is not recorded yet.
  it('does not yet record a read-only use of a global', () => {
    const map = mapOf({
      'store.py': 'count = 0\n\n\ndef show():\n    global count\n    return count\n',
    });

    expect(stateEdges(map)).toEqual([]);
  });
});
