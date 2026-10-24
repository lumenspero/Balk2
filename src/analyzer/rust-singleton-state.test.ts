import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectionGraph } from '../cli/build-graph.js';
import type { Balk2Config } from '../config/config.js';
import type { ConnectionMap } from '../types.js';

// Each case analyzes a repository on disk, so keep the default 5s limit out of the way.
vi.setConfig({ testTimeout: 60_000 });

const CARGO = '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n';
const SINGLETON: Balk2Config = {
  state: { singletons: [{ module: 'src/lib.rs', export: 'STORE' }] },
} as unknown as Balk2Config;
const STATE =
  'pub struct State {\n    pub count: u32,\n    pub stats: Stats,\n}\n\npub struct Stats {\n    pub hits: u32,\n}\n\n';

/** Writes the files to a temporary repository and returns the connection map. */
function mapOf(files: Record<string, string>, config: Balk2Config = SINGLETON): ConnectionMap {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-rust-singleton-'));
  try {
    for (const [name, content] of Object.entries({ 'Cargo.toml': CARGO, ...files })) {
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

const DECLARE = `${STATE}pub static mut STORE: State = State { count: 0, stats: Stats { hits: 0 } };\n`;

describe('rust configured singletons (V3 Phase 12.3)', () => {
  it('writes a field of a configured static mut', () => {
    const map = mapOf({
      'src/lib.rs': `${DECLARE}\npub fn set() {\n    unsafe { STORE.count = 2; }\n}\n`,
    });

    expect(stateEdges(map)).toEqual(['writesState src/lib.rs:set -> state:src/lib.rs:STORE#count']);
  });

  it('reads and writes a compound assignment to a field', () => {
    const map = mapOf({
      'src/lib.rs': `${DECLARE}\npub fn bump() {\n    unsafe { STORE.count += 1; }\n}\n`,
    });

    expect(stateEdges(map)).toEqual([
      'readsState src/lib.rs:bump -> state:src/lib.rs:STORE#count',
      'writesState src/lib.rs:bump -> state:src/lib.rs:STORE#count',
    ]);
  });

  it('records a static field path below the singleton', () => {
    const map = mapOf({
      'src/lib.rs': `${DECLARE}\npub fn record() {\n    unsafe { STORE.stats.hits = 1; }\n}\n`,
    });

    expect(stateEdges(map)).toEqual([
      'writesState src/lib.rs:record -> state:src/lib.rs:STORE#stats.hits',
    ]);
  });

  it('writes the whole singleton without a field', () => {
    const map = mapOf({
      'src/lib.rs': `${DECLARE}\npub fn reset() {\n    unsafe { STORE = State { count: 0, stats: Stats { hits: 0 } }; }\n}\n`,
    });

    expect(stateEdges(map)).toEqual(['writesState src/lib.rs:reset -> state:src/lib.rs:STORE']);
  });

  it('gives no state for a field of a static that is not configured', () => {
    const map = mapOf(
      { 'src/lib.rs': `${DECLARE}\npub fn set() {\n    unsafe { STORE.count = 2; }\n}\n` },
      {
        state: { singletons: [{ module: 'src/lib.rs', export: 'OTHER' }] },
      } as unknown as Balk2Config,
    );

    expect(stateEdges(map)).toEqual([]);
  });

  it('gives no state for a field write without any configuration', () => {
    const map = mapOf(
      { 'src/lib.rs': `${DECLARE}\npub fn set() {\n    unsafe { STORE.count = 2; }\n}\n` },
      {} as Balk2Config,
    );

    expect(stateEdges(map)).toEqual([]);
  });

  it('gives no state for a field of a local that shadows the singleton', () => {
    const map = mapOf({
      'src/lib.rs': `${DECLARE}\npub fn set() {\n    let STORE = State { count: 0, stats: Stats { hits: 0 } };\n    let mut s = STORE;\n    s.count = 2;\n}\n`,
    });

    expect(stateEdges(map)).toEqual([]);
  });
});
