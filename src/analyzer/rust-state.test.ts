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

/** Writes the files to a temporary repository and returns the connection map. */
function mapOf(files: Record<string, string>): ConnectionMap {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-rust-state-'));
  try {
    for (const [name, content] of Object.entries({ 'Cargo.toml': CARGO, ...files })) {
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

describe('rust static mut writes as shared state (V3 Phase 12.3)', () => {
  it('writes a static mut from inside an unsafe block', () => {
    const map = mapOf({
      'src/lib.rs':
        'pub static mut COUNT: i32 = 0;\n\npub fn set_it() {\n    unsafe {\n        COUNT = 2;\n    }\n}\n',
    });

    expect(stateEdges(map)).toEqual(['writesState src/lib.rs:set_it -> state:src/lib.rs:COUNT']);
  });

  it('reads and writes a compound assignment to a static mut', () => {
    const map = mapOf({
      'src/lib.rs':
        'pub static mut COUNT: i32 = 0;\n\npub fn bump() {\n    unsafe {\n        COUNT += 1;\n    }\n}\n',
    });

    expect(stateEdges(map)).toEqual([
      'readsState src/lib.rs:bump -> state:src/lib.rs:COUNT',
      'writesState src/lib.rs:bump -> state:src/lib.rs:COUNT',
    ]);
  });

  it('reaches a static mut in another module through a use', () => {
    const map = mapOf({
      'src/state.rs': 'pub static mut COUNT: i32 = 0;\n',
      'src/lib.rs':
        'mod state;\nuse crate::state::COUNT;\n\npub fn set_it() {\n    unsafe {\n        COUNT = 3;\n    }\n}\n',
    });

    expect(stateEdges(map)).toEqual(['writesState src/lib.rs:set_it -> state:src/state.rs:COUNT']);
  });

  it('gives no state for a local that shadows the static', () => {
    const map = mapOf({
      'src/lib.rs':
        'pub static mut COUNT: i32 = 0;\n\npub fn local() -> i32 {\n    let mut COUNT = 1;\n    COUNT += 1;\n    COUNT\n}\n',
    });

    expect(stateEdges(map)).toEqual([]);
  });

  it('gives no state for a static that is not mutable, or a field of the same name', () => {
    const map = mapOf({
      'src/lib.rs':
        'pub static COUNT: i32 = 0;\npub struct Box {\n    pub count: i32,\n}\n\npub fn touch(b: &mut Box) {\n    b.count = 1;\n}\n',
    });

    expect(stateEdges(map)).toEqual([]);
  });
});
