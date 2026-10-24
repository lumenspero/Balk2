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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-module-let-'));
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

describe('module-level let as shared state (V3 Phase 12.3)', () => {
  it('reads and writes a module let that a function reassigns', () => {
    const map = mapOf({
      'store.ts':
        'export let count = 0;\n\nexport function bump(): void {\n  count += 1;\n}\n\nexport function read(): number {\n  return count;\n}\n',
    });

    // `count += 1` both reads and writes, as compound assignments do for every state path.
    expect(stateEdges(map)).toEqual([
      'readsState store.ts:bump -> state:store.ts:count',
      'readsState store.ts:read -> state:store.ts:count',
      'writesState store.ts:bump -> state:store.ts:count',
    ]);
  });

  it('gives no state for a module let that only module-level code assigns', () => {
    const map = mapOf({
      'config.ts':
        "export let mode = 'a';\nmode = 'b';\n\nexport function show(): string {\n  return mode;\n}\n",
    });

    expect(stateEdges(map)).toEqual([]);
  });
});
