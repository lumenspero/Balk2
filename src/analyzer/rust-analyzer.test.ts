import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { RustAnalyzer } from './rust-analyzer.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function crateWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-rust-analyzer-test-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, 'utf8');
  }
  return root;
}

const CARGO = '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n';

describe('RustAnalyzer compatibility wrapper (V3 Phase 16.5)', () => {
  it('names itself and accepts only Rust files', () => {
    const analyzer = new RustAnalyzer();
    expect(analyzer.name).toBe('RustAnalyzer');
    expect(analyzer.supportedExtensions).toEqual(['.rs']);
    expect(analyzer.canAnalyze('src/lib.rs')).toBe(true);
    expect(analyzer.canAnalyze('src/util.py')).toBe(false);
  });

  it('analyzes one file and records its symbols', () => {
    const graph = new ConnectionGraph();
    new RustAnalyzer().analyzeFile('src/lib.rs', 'pub fn run() -> i32 {\n    1\n}\n', graph);
    const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });

    expect(Object.keys(map.files)).toContain('src/lib.rs');
    expect(Object.keys(map.symbols)).toContain('src/lib.rs:run');
  });

  it('follows a module declaration to a sibling file listed in knownFiles', () => {
    const root = crateWith({
      'Cargo.toml': CARGO,
      'src/util.rs': 'pub fn help() -> i32 {\n    2\n}\n',
    });
    const graph = new ConnectionGraph();
    new RustAnalyzer().analyzeFile('src/lib.rs', 'pub mod util;\n', graph, {
      rootDir: root,
      knownFiles: ['Cargo.toml', 'src/util.rs'],
    });
    const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });

    expect(
      map.relationships.some(
        (r) => r.type === 'declaresModule' && r.from === 'src/lib.rs' && r.to === 'src/util.rs',
      ),
    ).toBe(true);
  });

  it('leaves the caller rootDir unchanged', () => {
    const root = crateWith({ 'Cargo.toml': CARGO });
    new RustAnalyzer().analyzeFile('src/lib.rs', 'pub fn run() {}\n', new ConnectionGraph(), {
      rootDir: root,
      knownFiles: ['Cargo.toml'],
    });
    expect(fs.existsSync(path.join(root, 'src', 'lib.rs'))).toBe(false);
  });
});
