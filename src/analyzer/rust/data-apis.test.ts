import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../../graph.js';
import type { ConnectionMap } from '../../types.js';
import { RustFrontEnd } from './front-end.js';

const META = { generatedAt: '2026-01-01T00:00:00Z' };
const CARGO = '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n';

/**
 * Writes the files to a temporary repository, runs the Rust front end over them, and returns the
 * map. `dataFiles` are repository files that are not Rust sources, so they can be placed as paths.
 */
function analyze(files: Record<string, string>, dataFiles: readonly string[] = []): ConnectionMap {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-rust-data-'));
  try {
    const all = { ...files };
    for (const name of dataFiles) all[name] = '';
    for (const [name, content] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(rootDir, name)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, name), content, 'utf8');
    }
    const graph = new ConnectionGraph();
    new RustFrontEnd().analyze({ rootDir, files: Object.keys(all) }, graph);
    return graph.build(META);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

/** Data edges that point at one artifact, as `type/confidence from`, sorted. */
function edgesTo(map: ConnectionMap, artifact: string): string[] {
  return map.relationships
    .filter((r) => r.to === artifact && ['generates', 'consumes', 'reads'].includes(r.type))
    .map((r) => `${r.type}/${r.confidence} ${r.from}`)
    .sort();
}

describe('Rust data catalog: resolved std and crate calls (Phase 11.3)', () => {
  it('std::fs::copy reads its source and writes its destination', () => {
    const map = analyze({
      'Cargo.toml': CARGO,
      'src/main.rs': 'fn main() { std::fs::copy("src/a.csv", "dst/b.csv").unwrap(); }',
    });
    expect(edgesTo(map, 'src/a.csv')).toEqual(['consumes/high src/main.rs']);
    expect(edgesTo(map, 'dst/b.csv')).toEqual(['generates/high src/main.rs']);
  });

  it('File::create generates through a use import, where a keyword rule would not', () => {
    const map = analyze({
      'Cargo.toml': CARGO,
      'src/main.rs': [
        'use std::fs::File;',
        'fn main() { let _f = File::create("out/report.json").unwrap(); }',
      ].join('\n'),
    });
    expect(edgesTo(map, 'out/report.json')).toEqual(['generates/high src/main.rs']);
  });

  it('Connection::open reads at high confidence', () => {
    const map = analyze({
      'Cargo.toml': CARGO,
      'src/main.rs': [
        'use rusqlite::Connection;',
        'fn main() { let _c = Connection::open("db/store.sqlite").unwrap(); }',
      ].join('\n'),
    });
    expect(edgesTo(map, 'db/store.sqlite')).toEqual(['reads/high src/main.rs']);
  });

  it('Path::new and PathBuf::from wrap the literal for the catalog', () => {
    const map = analyze({
      'Cargo.toml': CARGO,
      'src/main.rs': [
        'use std::fs;',
        'use std::path::{Path, PathBuf};',
        'fn main() {',
        '    fs::copy(Path::new("src/a.csv"), PathBuf::from("dst/b.csv")).unwrap();',
        '}',
      ].join('\n'),
    });
    expect(edgesTo(map, 'src/a.csv')).toEqual(['consumes/high src/main.rs']);
    expect(edgesTo(map, 'dst/b.csv')).toEqual(['generates/high src/main.rs']);
  });
});

describe('Rust data catalog: negatives (Phase 11.3)', () => {
  it('a method named like a catalog API on a local value is not matched', () => {
    const map = analyze({
      'Cargo.toml': CARGO,
      'src/main.rs': [
        'struct Helper;',
        'impl Helper { fn open(&self, p: &str) {} }',
        'fn main() { let h = Helper; h.open("x.json"); }',
      ].join('\n'),
    });
    expect(edgesTo(map, 'x.json')).toEqual([]);
  });

  it('a bare call with no use of std::fs is not matched', () => {
    const map = analyze({
      'Cargo.toml': CARGO,
      'src/main.rs': 'fn copy(a: &str, b: &str) {}\nfn main() { copy("a.json", "b.json"); }',
    });
    expect(edgesTo(map, 'a.json')).toEqual([]);
    expect(edgesTo(map, 'b.json')).toEqual([]);
  });

  it('a path in a non-path argument position is not matched', () => {
    // `contents.json` is the second argument of write, which is the data, not the path.
    const map = analyze({
      'Cargo.toml': CARGO,
      'src/main.rs': 'fn main() { std::fs::write("out.json", "contents.json").unwrap(); }',
    });
    expect(edgesTo(map, 'out.json')).toEqual(['generates/high src/main.rs']);
    expect(edgesTo(map, 'contents.json')).toEqual([]);
  });
});

describe('Rust bare paths (Phase 11.3 with 11.4)', () => {
  it('places a bare path from the package directory when the file exists there', () => {
    const map = analyze(
      {
        'crates/core/Cargo.toml': CARGO,
        'crates/core/src/lib.rs':
          'pub fn load() { std::fs::read_to_string("fixtures/a.json").unwrap(); }',
      },
      ['crates/core/fixtures/a.json'],
    );
    expect(edgesTo(map, 'crates/core/fixtures/a.json')).toEqual([
      'consumes/high crates/core/src/lib.rs',
    ]);
    expect(edgesTo(map, 'fixtures/a.json')).toEqual([]);
  });
});
