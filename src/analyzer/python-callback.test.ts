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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-py-callback-'));
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

/** The callback relationships as `type from -> to`, sorted, for readable assertions. */
function callbackEdges(map: ConnectionMap): string[] {
  return map.relationships
    .filter((r) => r.type === 'passesCallback')
    .map((r) => `${r.type} ${r.from} -> ${r.to}`)
    .sort();
}

describe('python callbacks passed to threading.Thread (V3 Phase 12.4)', () => {
  it('links the thread function, passed by keyword, to the function that starts it', () => {
    const map = mapOf({
      'main.py':
        'import threading\n\n\ndef worker():\n    pass\n\n\ndef start():\n    threading.Thread(target=worker).start()\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:start -> main.py:worker']);
  });

  it('links a function imported from another repository module', () => {
    const map = mapOf({
      'jobs.py': 'def worker():\n    pass\n',
      'main.py':
        'import threading\nfrom jobs import worker\n\n\ndef start():\n    threading.Thread(target=worker).start()\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback main.py:start -> jobs.py:worker']);
  });

  it('reports a callback that is a parameter as unresolved, at low confidence', () => {
    const map = mapOf({
      'main.py':
        'import threading\n\n\ndef start(job):\n    threading.Thread(target=job).start()\n',
    });

    const observation = Object.values(map.unresolved).find(
      (node) => node.reason === 'unresolved-callback',
    );
    expect(observation).toBeDefined();
    expect(map.relationships).toContainEqual(
      expect.objectContaining({
        type: 'passesCallback',
        from: 'main.py:start',
        to: observation?.id,
        confidence: 'low',
      }),
    );
    expect(callbackEdges(map)).toEqual([`passesCallback main.py:start -> ${observation?.id}`]);
  });

  it('gives no edge for a Thread that is not the threading library', () => {
    const map = mapOf({
      'other.py': 'class Thread:\n    pass\n',
      'main.py':
        'from other import Thread\n\n\ndef worker():\n    pass\n\n\ndef start():\n    Thread(target=worker)\n',
    });

    expect(callbackEdges(map)).toEqual([]);
  });

  it('gives no edge for a threading callable other than Thread', () => {
    const map = mapOf({
      'main.py':
        'import threading\n\n\ndef worker():\n    pass\n\n\ndef start():\n    threading.Timer(1, worker).start()\n',
    });

    expect(callbackEdges(map)).toEqual([]);
  });
});
