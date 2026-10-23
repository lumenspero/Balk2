import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectionGraph } from '../cli/build-graph.js';

// Each run analyzes three languages; the default 5s limit is tight on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

/**
 * The Phase 11 exit criterion: Python writes JSON, Rust reads that JSON and writes Parquet, and
 * TypeScript reads the Parquet. Each hop is found through the whole pipeline, so the four edges meet
 * at the same artifact paths.
 */
const FILES: Record<string, string> = {
  'Cargo.toml': '[package]\nname = "convert"\nversion = "0.1.0"\nedition = "2021"\n',
  'pipeline/make.py': [
    'import json',
    '',
    '',
    'def make():',
    "    with open('data/rows.json', 'w') as f:",
    '        json.dump([], f)',
    '',
  ].join('\n'),
  'src/main.rs': [
    'fn convert() {',
    '    let _rows = std::fs::read_to_string("data/rows.json").unwrap();',
    '    let _out = std::fs::File::create("data/rows.parquet").unwrap();',
    '}',
    'fn main() {',
    '    convert();',
    '}',
    '',
  ].join('\n'),
  'web/read.ts': [
    "import { readFileSync } from 'node:fs';",
    '',
    'export function load(): string {',
    "  return readFileSync('data/rows.parquet', 'utf8');",
    '}',
    '',
  ].join('\n'),
};

describe('data lineage across languages (Phase 11 exit criterion)', () => {
  it('connects Python to JSON, Rust to JSON and Parquet, and TypeScript to Parquet', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-pipeline-'));
    try {
      for (const [name, content] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(rootDir, name)), { recursive: true });
        fs.writeFileSync(path.join(rootDir, name), content, 'utf8');
      }
      const map = buildConnectionGraph(rootDir).build({ generatedAt: '2026-01-01T00:00:00Z' });
      const edges = map.relationships
        .filter(
          (r) => ['generates', 'consumes', 'reads'].includes(r.type) && r.confidence === 'high',
        )
        .map((r) => `${r.type} ${r.from} -> ${r.to}`)
        .sort();
      expect(edges).toEqual([
        'consumes src/main.rs -> data/rows.json',
        'consumes web/read.ts -> data/rows.parquet',
        'generates pipeline/make.py -> data/rows.json',
        'generates src/main.rs -> data/rows.parquet',
      ]);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
