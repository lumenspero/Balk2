import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import type { Balk2Config } from '../config/balk2-config.js';
import { scanRepositoryFiles } from '../cli/build-graph.js';
import { JsTsFrontEnd } from './js-ts-front-end.js';
import { PythonFrontEnd } from './python-front-end.js';
import { ConnectionGraph } from '../graph.js';

const FIXTURE = path.resolve(__dirname, '../../test/fixtures/python-baseline');

describe('PythonFrontEnd', () => {
  it('handles Python files only', () => {
    const front = new PythonFrontEnd();
    expect(front.canHandle('pkg/mod.py')).toBe(true);
    expect(front.canHandle('src/index.ts')).toBe(false);
    expect(front.languages).toEqual(['python']);
  });

  it('reads source annotations from the Python files it analyzes', () => {
    const files = scanRepositoryFiles(FIXTURE);
    const result = new PythonFrontEnd().analyze({ rootDir: FIXTURE, files }, new ConnectionGraph());
    expect(result.sourceAnnotations?.annotations.length).toBeGreaterThan(0);
  });
});

describe('JsTsFrontEnd', () => {
  it('handles JS and TS files only', () => {
    const front = new JsTsFrontEnd();
    expect(front.canHandle('src/index.ts')).toBe(true);
    expect(front.canHandle('scripts/run.mjs')).toBe(true);
    expect(front.canHandle('pkg/mod.py')).toBe(false);
  });

  it('returns no source annotations when it has no files', () => {
    const graph = new ConnectionGraph();
    const result = new JsTsFrontEnd().analyze({ rootDir: FIXTURE, files: ['notes.md'] }, graph);
    expect(result.sourceAnnotations).toBeUndefined();
    expect(result.syntaxErrors).toEqual([]);
  });
});

describe('python.identityDecorators reaches call analysis', () => {
  const FILES: Record<string, string> = {
    'deco.py': 'def my_cache(f):\n    return lambda *a: f(*a)\n',
    'app.py':
      'from deco import my_cache\n\n@my_cache\ndef task():\n    return 1\n\ndef main():\n    return task()\n',
  };

  /** Analyzes a temporary repository and returns the confidence of the main -> task call. */
  function mainToTaskConfidence(config: Balk2Config | undefined): string | undefined {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-identity-'));
    try {
      for (const [rel, text] of Object.entries(FILES)) {
        fs.writeFileSync(path.join(dir, rel), text, 'utf8');
      }
      const graph = new ConnectionGraph();
      new PythonFrontEnd().analyze({ rootDir: dir, files: ['app.py', 'deco.py'], config }, graph);
      return graph
        .getRelationships()
        .find((r) => r.type === 'calls' && r.from === 'app.py:main' && r.to === 'app.py:task')
        ?.confidence;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('keeps a call through a configured identity decorator at high confidence', () => {
    expect(mainToTaskConfidence(undefined)).toBe('medium');
    expect(mainToTaskConfidence({ python: { identityDecorators: ['my_cache'] } })).toBe('high');
  });
});

describe('python.roots reaches import resolution', () => {
  /** Analyzes a temporary repository and reports whether app.py imports src/pkg/mod.py. */
  function importsModule(config: Balk2Config | undefined): boolean {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-roots-'));
    try {
      fs.mkdirSync(path.join(dir, 'src', 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'pkg', 'mod.py'), 'def f():\n    return 1\n', 'utf8');
      fs.writeFileSync(
        path.join(dir, 'app.py'),
        'from pkg.mod import f\n\ndef main():\n    return f()\n',
        'utf8',
      );
      const graph = new ConnectionGraph();
      new PythonFrontEnd().analyze(
        { rootDir: dir, files: ['app.py', 'src/pkg/mod.py'], config },
        graph,
      );
      return graph
        .getRelationships()
        .some((r) => r.type === 'imports' && r.from === 'app.py' && r.to === 'src/pkg/mod.py');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  it('resolves an import only under a configured root', () => {
    expect(importsModule(undefined)).toBe(false);
    expect(importsModule({ python: { roots: ['src'] } })).toBe(true);
  });
});
