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
