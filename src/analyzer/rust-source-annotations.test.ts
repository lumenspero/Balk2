import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectionGraphDetailed } from '../cli/build-graph.js';
import type { Balk2Config } from '../config/config.js';
import type { ConnectionMap } from '../types.js';

// Each case analyzes a repository on disk, so keep the default 5s limit out of the way.
vi.setConfig({ testTimeout: 60_000 });

const CARGO = '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n';

/** Writes the files to a temporary repository and returns the map and the build problems. */
function build(files: Record<string, string>): { map: ConnectionMap; problems: string[] } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-rust-annotations-'));
  try {
    for (const [name, content] of Object.entries({ 'Cargo.toml': CARGO, ...files })) {
      fs.mkdirSync(path.dirname(path.join(rootDir, name)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, name), content, 'utf8');
    }
    const result = buildConnectionGraphDetailed(rootDir, {} as Balk2Config);
    return {
      map: result.graph.build({ generatedAt: '2026-01-01T00:00:00Z' }),
      problems: result.problems.map((problem) => problem.message),
    };
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

/** The confidence of the calls edge from `from` to `to`, or undefined. */
function callConfidence(map: ConnectionMap, from: string, to: string): string | undefined {
  return map.relationships.find((rel) => rel.type === 'calls' && rel.from === from && rel.to === to)
    ?.confidence;
}

const HELPER = 'pub fn helper() -> u32 {\n    1\n}\n\n';

describe('rust source annotations (V3 Phase 12.7)', () => {
  it('applies a directive above a statement that names the enclosing function', () => {
    const { map, problems } = build({
      'src/lib.rs': `${HELPER}pub fn outer() -> u32 {\n    // balk2: confidence=low src/lib.rs:outer calls src/lib.rs:helper\n    helper()\n}\n`,
    });
    expect(problems.filter((message) => message.includes('balk2'))).toEqual([]);
    expect(callConfidence(map, 'src/lib.rs:outer', 'src/lib.rs:helper')).toBe('low');
  });

  it('ignores a directive that names another owner, and reports it', () => {
    const { map, problems } = build({
      'src/lib.rs': `${HELPER}pub fn outer() -> u32 {\n    // balk2: confidence=low src/lib.rs:helper calls src/lib.rs:outer\n    helper()\n}\n`,
    });
    expect(problems).toContainEqual(expect.stringContaining('does not match the enclosing owner'));
    expect(callConfidence(map, 'src/lib.rs:outer', 'src/lib.rs:helper')).toBe('high');
  });

  it('never reads a doc comment as a directive', () => {
    const { map, problems } = build({
      'src/lib.rs': `${HELPER}pub fn outer() -> u32 {\n    /// balk2: confidence=low src/lib.rs:outer calls src/lib.rs:helper\n    helper()\n}\n`,
    });
    expect(problems.filter((message) => message.includes('balk2'))).toEqual([]);
    expect(callConfidence(map, 'src/lib.rs:outer', 'src/lib.rs:helper')).toBe('high');
  });

  it('reports a directive that is not directly above the statement it annotates', () => {
    const { map, problems } = build({
      'src/lib.rs': `${HELPER}pub fn outer() -> u32 {\n    // balk2: confidence=low src/lib.rs:outer calls src/lib.rs:helper\n\n    helper()\n}\n`,
    });
    expect(problems).toContainEqual(expect.stringContaining('must sit directly above'));
    expect(callConfidence(map, 'src/lib.rs:outer', 'src/lib.rs:helper')).toBe('high');
  });

  it('never reads text inside a string as a directive', () => {
    const { map, problems } = build({
      'src/lib.rs': `${HELPER}pub fn outer() -> u32 {\n    let _s = "// balk2: confidence=low src/lib.rs:outer calls src/lib.rs:helper";\n    helper()\n}\n`,
    });
    expect(problems.filter((message) => message.includes('balk2'))).toEqual([]);
    expect(callConfidence(map, 'src/lib.rs:outer', 'src/lib.rs:helper')).toBe('high');
  });
});
