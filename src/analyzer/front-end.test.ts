import * as path from 'path';
import { describe, expect, it } from 'vitest';
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
