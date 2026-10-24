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
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-rust-callback-'));
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

/** The callback relationships as `type from -> to`, sorted, for readable assertions. */
function callbackEdges(map: ConnectionMap): string[] {
  return map.relationships
    .filter((r) => r.type === 'passesCallback')
    .map((r) => `${r.type} ${r.from} -> ${r.to}`)
    .sort();
}

describe('rust callbacks passed to thread::spawn and iterator methods (V3 Phase 12.4)', () => {
  it('links the function passed to thread::spawn', () => {
    const map = mapOf({
      'src/lib.rs':
        'use std::thread;\n\nfn worker() {}\n\npub fn start() {\n    thread::spawn(worker);\n}\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback src/lib.rs:start -> src/lib.rs:worker']);
  });

  it('links the function passed to std::thread::spawn by its full path', () => {
    const map = mapOf({
      'src/lib.rs': 'fn worker() {}\n\npub fn start() {\n    std::thread::spawn(worker);\n}\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback src/lib.rs:start -> src/lib.rs:worker']);
  });

  it('records a closure passed to thread::spawn as an inline callback of its caller', () => {
    const map = mapOf({
      'src/lib.rs':
        'use std::thread;\n\npub fn start() {\n    thread::spawn(move || {\n        let _ = 1;\n    });\n}\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback src/lib.rs:start -> src/lib.rs:start']);
  });

  it('links the function passed to an iterator method', () => {
    const map = mapOf({
      'src/lib.rs':
        'fn parse(x: &str) -> i32 {\n    x.len() as i32\n}\n\npub fn run(items: Vec<&str>) -> Vec<i32> {\n    items.into_iter().map(parse).collect()\n}\n',
    });

    expect(callbackEdges(map)).toEqual(['passesCallback src/lib.rs:run -> src/lib.rs:parse']);
  });

  it('reports a callback that is a parameter as unresolved, at low confidence', () => {
    const map = mapOf({
      'src/lib.rs': 'use std::thread;\n\npub fn start(job: fn()) {\n    thread::spawn(job);\n}\n',
    });

    const observation = Object.values(map.unresolved).find(
      (node) => node.reason === 'unresolved-callback',
    );
    expect(observation).toBeDefined();
    expect(map.relationships).toContainEqual(
      expect.objectContaining({
        type: 'passesCallback',
        from: 'src/lib.rs:start',
        to: observation?.id,
        confidence: 'low',
      }),
    );
  });

  it('gives no edge when a repository module named thread shadows the standard library', () => {
    const map = mapOf({
      'src/lib.rs':
        'mod thread {\n    pub fn spawn(_f: fn()) {}\n}\n\nfn worker() {}\n\npub fn start() {\n    thread::spawn(worker);\n}\n',
    });

    expect(callbackEdges(map)).toEqual([]);
  });
});
