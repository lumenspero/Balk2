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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-rust-native-'));
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

/** The observations of native loads: reason and subject, in file order. */
function loadObservations(map: ConnectionMap): string[] {
  return Object.values(map.unresolved)
    .filter(
      (node) =>
        node.detail?.includes('native library') === true ||
        node.detail?.includes('not a string literal') === true,
    )
    .map((node) => `${node.reason} ${node.subject}`);
}

describe('rust native library loads (V3 Phase 12.5)', () => {
  it('records a literal library path as an observation from the loading function', () => {
    const map = mapOf({
      'src/lib.rs':
        'pub fn load() {\n    let _ = unsafe { libloading::Library::new("libplugin.so") };\n}\n',
    });
    expect(loadObservations(map)).toEqual(['unresolved-module-path libplugin.so']);
    expect(map.relationships).toContainEqual(
      expect.objectContaining({
        type: 'imports',
        from: 'src/lib.rs:load',
        confidence: 'low',
        metadata: { mechanism: 'native-library' },
      }),
    );
  });

  it('records a computed library path as a dynamic-module-specifier observation', () => {
    const map = mapOf({
      'src/lib.rs':
        'pub fn load(path: &str) {\n    let _ = unsafe { libloading::Library::new(path) };\n}\n',
    });
    expect(loadObservations(map)).toEqual([
      'dynamic-module-specifier libloading::Library::new(path)',
    ]);
  });

  it('is silent for a Library::new on another path', () => {
    const map = mapOf({
      'src/lib.rs':
        'pub fn load() {\n    let _ = unsafe { other::Library::new("libplugin.so") };\n}\n',
    });
    expect(loadObservations(map)).toEqual([]);
  });
});
