import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';
import { analyzePythonSources } from './python-front-end.js';

const META = { generatedAt: '2026-01-01T00:00:00Z' };

/** Runs the Python front end over the files and returns the built map. */
function analyze(files: Record<string, string>): ConnectionMap {
  const graph = new ConnectionGraph();
  const sources = Object.entries(files).map(([filePath, source]) => ({ filePath, source }));
  analyzePythonSources(sources, new Set(Object.keys(files)), (p) => files[p] ?? '', graph);
  return graph.build(META);
}

/** Data edges that point at one artifact, as `type/confidence from`, sorted. */
function edgesTo(map: ConnectionMap, artifact: string): string[] {
  return map.relationships
    .filter((r) => r.to === artifact && ['generates', 'consumes', 'reads'].includes(r.type))
    .map((r) => `${r.type}/${r.confidence} ${r.from}`)
    .sort();
}

describe('Python data catalog: resolved library calls (Phase 11.2)', () => {
  it('sqlite3.connect reads at high confidence, where the keyword rule gives a low guess', () => {
    const map = analyze({
      'app.py': ['import sqlite3', "conn = sqlite3.connect('db/store.sqlite')"].join('\n'),
    });
    expect(edgesTo(map, 'db/store.sqlite')).toContain('reads/high app.py');
  });

  it('numpy.savetxt generates, where the keyword rule reads', () => {
    const map = analyze({
      'app.py': ['import numpy as np', "np.savetxt('out/arr.csv', [1, 2])"].join('\n'),
    });
    expect(edgesTo(map, 'out/arr.csv')).toEqual(['generates/high app.py']);
  });

  it('builtin open writes when its mode writes, and reads by default', () => {
    const map = analyze({
      'app.py': [
        "with open('out/result.json', 'w') as f:",
        '    f.write("{}")',
        "data = open('in/config.json')",
      ].join('\n'),
    });
    expect(edgesTo(map, 'out/result.json')).toEqual(['generates/high app.py']);
    expect(edgesTo(map, 'in/config.json')).toEqual(['consumes/high app.py']);
  });

  it('shutil.copy reads its source and writes its destination', () => {
    const map = analyze({
      'app.py': ['import shutil', "shutil.copy('src/a.csv', 'dst/b.csv')"].join('\n'),
    });
    expect(edgesTo(map, 'src/a.csv')).toEqual(['consumes/high app.py']);
    expect(edgesTo(map, 'dst/b.csv')).toEqual(['generates/high app.py']);
  });

  it('a path on a line after the one a catalog call claims is still read by the keyword rule', () => {
    // The catalog claims the literal on line 2. The keyword rule must still give line 3 its edge.
    const map = analyze({
      'app.py': [
        'import sqlite3',
        "conn = sqlite3.connect('db/a.sqlite')",
        'other = "notes.txt"',
        "note = 'x.json'",
      ].join('\n'),
    });
    expect(edgesTo(map, 'db/a.sqlite')).toEqual(['reads/high app.py']);
    expect(edgesTo(map, 'db/a.sqlite').filter((e) => e.includes('/low'))).toEqual([]);
    expect(edgesTo(map, 'x.json')).toEqual(['reads/low app.py']);
  });
});

describe('Python data catalog: negatives (Phase 11.2)', () => {
  it('a repository function named like a catalog API is not matched', () => {
    const map = analyze({
      'app.py': ['def connect(path):', '    return path', "conn = connect('db/store.sqlite')"].join(
        '\n',
      ),
    });
    expect(edgesTo(map, 'db/store.sqlite').filter((e) => e.includes('/high'))).toEqual([]);
  });

  it('a local variable with the module name is not the module', () => {
    const map = analyze({
      'app.py': [
        'class Helper:',
        '    def connect(self, path):',
        '        return path',
        'sqlite3 = Helper()',
        "conn = sqlite3.connect('db/y.sqlite')",
      ].join('\n'),
    });
    expect(edgesTo(map, 'db/y.sqlite').filter((e) => e.includes('/high'))).toEqual([]);
  });

  it('a call on a module that is never imported is not matched', () => {
    const map = analyze({
      'app.py': "conn = sqlite3.connect('db/z.sqlite')",
    });
    expect(edgesTo(map, 'db/z.sqlite').filter((e) => e.includes('/high'))).toEqual([]);
  });
});

describe('Python bare paths (Phase 11.2 with 11.4)', () => {
  it('places a catalog path from the script directory when that file exists', () => {
    const map = analyze({
      'scripts/load.py': ['import sqlite3', "conn = sqlite3.connect('store.sqlite')"].join('\n'),
      'scripts/store.sqlite': '',
    });
    expect(edgesTo(map, 'scripts/store.sqlite')).toEqual(['reads/high scripts/load.py']);
    expect(edgesTo(map, 'store.sqlite')).toEqual([]);
  });
});

describe('Python constants carry paths to catalog calls (Phase 11.5)', () => {
  it('an upper-case module constant passed to connect reads at high confidence', () => {
    const map = analyze({
      'app.py': ['import sqlite3', "DB = 'db/app.sqlite'", 'conn = sqlite3.connect(DB)'].join('\n'),
    });
    expect(edgesTo(map, 'db/app.sqlite')).toContain('reads/high app.py');
  });

  it('a Final-annotated constant passed to open is written', () => {
    const map = analyze({
      'app.py': [
        'from typing import Final',
        "OUT: Final = 'out/report.json'",
        "with open(OUT, 'w') as f:",
        "    f.write('{}')",
      ].join('\n'),
    });
    expect(edgesTo(map, 'out/report.json')).toContain('generates/high app.py');
  });

  it('a constant imported from another repository module generates in the calling file', () => {
    const map = analyze({
      'config.py': "OUT_CSV = 'out/data.csv'\n",
      'app.py': [
        'import numpy as np',
        'from config import OUT_CSV',
        'np.savetxt(OUT_CSV, [1, 2])',
      ].join('\n'),
    });
    expect(edgesTo(map, 'out/data.csv')).toContain('generates/high app.py');
  });

  it('a constant is placed from the file that declares it', () => {
    const map = analyze({
      'lib/cfg.py': "DB = 'store.sqlite'\n",
      'lib/app.py': ['import sqlite3', 'from .cfg import DB', 'sqlite3.connect(DB)'].join('\n'),
      'lib/store.sqlite': '',
    });
    expect(edgesTo(map, 'lib/store.sqlite')).toContain('reads/high lib/app.py');
    // The declaration's own line still gets the existing low keyword edge, which is baseline behavior.
    expect(edgesTo(map, 'store.sqlite').filter((e) => e.includes('/high'))).toEqual([]);
  });

  it('a keyword-rule literal is placed beside its file, as the catalog calls are (Phase 11.6)', () => {
    const map = analyze({
      'lib/app.py': "note = 'cfg.json'",
      'lib/cfg.json': '{}',
    });
    expect(edgesTo(map, 'lib/cfg.json')).toEqual(['reads/low lib/app.py']);
    expect(edgesTo(map, 'cfg.json')).toEqual([]);
  });

  it('a keyword-rule literal with no existing file is placed at the root (Phase 11.6)', () => {
    const map = analyze({ 'lib/app.py': "note = 'missing.json'" });
    expect(edgesTo(map, 'missing.json')).toEqual(['reads/low lib/app.py']);
  });

  it('a lower-case name is not a constant', () => {
    const map = analyze({
      'app.py': ['import sqlite3', "db = 'db/lower.sqlite'", 'sqlite3.connect(db)'].join('\n'),
    });
    expect(edgesTo(map, 'db/lower.sqlite').filter((e) => e.includes('/high'))).toEqual([]);
  });

  it('a constant bound twice is not a constant', () => {
    const map = analyze({
      'app.py': [
        'import sqlite3',
        "DB = 'db/first.sqlite'",
        "DB = 'db/second.sqlite'",
        'sqlite3.connect(DB)',
      ].join('\n'),
    });
    expect(edgesTo(map, 'db/first.sqlite').filter((e) => e.includes('/high'))).toEqual([]);
    expect(edgesTo(map, 'db/second.sqlite').filter((e) => e.includes('/high'))).toEqual([]);
  });
});

/** The high-confidence data edges that point at one artifact, as `type/confidence from`. */
function highEdgesTo(map: ConnectionMap, artifact: string): string[] {
  return edgesTo(map, artifact).filter((e) => e.includes('/high'));
}

describe('Python data catalog: method receivers (Phase 11.6)', () => {
  it('a Path bound once reads and writes the path it holds', () => {
    const map = analyze({
      'app.py': [
        'from pathlib import Path',
        "store = Path('data/cfg.json')",
        'text = store.read_text()',
        "store.write_text('{}')",
      ].join('\n'),
    });
    expect(highEdgesTo(map, 'data/cfg.json')).toEqual([
      'consumes/high app.py',
      'generates/high app.py',
    ]);
  });

  it('a Path called directly takes its method as the access', () => {
    const map = analyze({
      'app.py': ['from pathlib import Path', "Path('out/a.json').write_text('{}')"].join('\n'),
    });
    expect(highEdgesTo(map, 'out/a.json')).toEqual(['generates/high app.py']);
  });

  it('Path.open writes when its mode writes, and reads otherwise', () => {
    const map = analyze({
      'app.py': [
        'from pathlib import Path',
        "with Path('out/b.csv').open('w') as f:",
        '    f.write("x")',
        "data = Path('in/c.csv').open('r')",
      ].join('\n'),
    });
    expect(highEdgesTo(map, 'out/b.csv')).toEqual(['generates/high app.py']);
    expect(highEdgesTo(map, 'in/c.csv')).toEqual(['consumes/high app.py']);
  });

  it('a Path bound in a function is typed from that function', () => {
    const map = analyze({
      'app.py': [
        'from pathlib import Path',
        'def load():',
        "    p = Path('local/c.json')",
        '    return p.read_bytes()',
      ].join('\n'),
    });
    expect(highEdgesTo(map, 'local/c.json')).toEqual(['consumes/high app.py']);
  });

  it('a name bound to two paths is not typed, so neither path is read', () => {
    const map = analyze({
      'app.py': [
        'from pathlib import Path',
        "p = Path('x/a.json')",
        "p = Path('x/b.json')",
        'p.read_text()',
      ].join('\n'),
    });
    expect(highEdgesTo(map, 'x/a.json')).toEqual([]);
    expect(highEdgesTo(map, 'x/b.json')).toEqual([]);
  });

  it('a pandas DataFrame writes the destination of its to_ method', () => {
    const map = analyze({
      'app.py': [
        'import pandas as pd',
        "df = pd.read_csv('in/rows.csv')",
        "df.to_parquet('out/rows.parquet')",
      ].join('\n'),
    });
    expect(highEdgesTo(map, 'in/rows.csv')).toEqual(['consumes/high app.py']);
    expect(highEdgesTo(map, 'out/rows.parquet')).toEqual(['generates/high app.py']);
  });

  it('a method on a value that is not a pandas read is not a catalog call', () => {
    const map = analyze({
      'app.py': [
        'class Store:',
        '    def push(self, p):',
        '        return p',
        's = Store()',
        "s.push('out/x.csv')",
      ].join('\n'),
    });
    expect(highEdgesTo(map, 'out/x.csv')).toEqual([]);
  });
});

describe('Python data catalog: Polars frames (Phase 11.6)', () => {
  it('a Polars DataFrame writes the destination of its write_ method', () => {
    const map = analyze({
      'app.py': [
        'import polars as pl',
        "df = pl.read_csv('in/p.csv')",
        "df.write_parquet('out/p.parquet')",
      ].join('\n'),
    });
    expect(highEdgesTo(map, 'in/p.csv')).toEqual(['consumes/high app.py']);
    expect(highEdgesTo(map, 'out/p.parquet')).toEqual(['generates/high app.py']);
  });

  it('a LazyFrame from scan_ writes through sink_', () => {
    const map = analyze({
      'app.py': [
        'import polars as pl',
        "lf = pl.scan_parquet('in/q.parquet')",
        "lf.sink_csv('out/q.csv')",
      ].join('\n'),
    });
    expect(highEdgesTo(map, 'in/q.parquet')).toEqual(['consumes/high app.py']);
    expect(highEdgesTo(map, 'out/q.csv')).toEqual(['generates/high app.py']);
  });
});
