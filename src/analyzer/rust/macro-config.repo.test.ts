import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectionGraph } from '../../cli/build-graph.js';
import type { Balk2Config } from '../../config/balk2-config.js';
import type { ConnectionMap } from '../../types.js';

vi.setConfig({ testTimeout: 60_000 });

const CARGO = '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n';
const SOURCE = 'fn helper() -> u32 {\n    1\n}\n\npub fn start() {\n    log_info!(helper());\n}\n';

/** The call relationships of a repository written to a temporary directory. */
function callsWith(config: Balk2Config): string[] {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-rust-macro-config-'));
  try {
    fs.writeFileSync(path.join(rootDir, 'Cargo.toml'), CARGO);
    fs.mkdirSync(path.join(rootDir, 'src'));
    fs.writeFileSync(path.join(rootDir, 'src/lib.rs'), SOURCE);
    const map: ConnectionMap = buildConnectionGraph(rootDir, config).build({
      generatedAt: '2026-01-01T00:00:00Z',
    });
    return map.relationships
      .filter((r) => r.type === 'calls')
      .map((r) => `${r.from} -> ${r.to}`)
      .sort();
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

describe('rust.macros.expressionLike in the graph', () => {
  it('finds no call inside an unlisted macro', () => {
    expect(callsWith({} as Balk2Config)).toEqual([]);
  });

  it('finds the call inside a listed macro', () => {
    const config = { rust: { macros: { expressionLike: ['log_info'] } } } as Balk2Config;
    expect(callsWith(config)).toEqual(['src/lib.rs:start -> src/lib.rs:helper']);
  });
});
