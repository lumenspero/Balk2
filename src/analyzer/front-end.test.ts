import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { scanRepositoryFiles } from '../cli/build-graph.js';
import { ConnectionGraph } from '../graph.js';
import { canonicalGraph } from '../testing/canonical-graph.js';
import { LegacyPythonFrontEnd } from './legacy-python-front-end.js';
import { PythonAnalyzer } from './python-analyzer.js';

const FIXTURE = path.resolve(__dirname, '../../test/fixtures/python-baseline');
const BUILD_OPTIONS = { generatedAt: '2026-01-01T00:00:00Z' };

describe('LegacyPythonFrontEnd', () => {
  it('handles Python files only', () => {
    const front = new LegacyPythonFrontEnd();
    expect(front.canHandle('pkg/mod.py')).toBe(true);
    expect(front.canHandle('src/index.ts')).toBe(false);
    expect(front.languages).toEqual(['python']);
  });

  it('builds the same graph as the former per-file loop', () => {
    const files = scanRepositoryFiles(FIXTURE);

    const direct = new ConnectionGraph();
    const analyzer = new PythonAnalyzer();
    for (const relFile of files) {
      if (!analyzer.canAnalyze(relFile)) continue;
      const content = fs.readFileSync(path.join(FIXTURE, relFile), 'utf8');
      analyzer.analyzeFile(relFile, content, direct, { rootDir: FIXTURE, knownFiles: files });
    }

    const viaAdapter = new ConnectionGraph();
    const result = new LegacyPythonFrontEnd().analyze({ rootDir: FIXTURE, files }, viaAdapter);

    expect(canonicalGraph(viaAdapter.build(BUILD_OPTIONS))).toBe(
      canonicalGraph(direct.build(BUILD_OPTIONS)),
    );
    const pythonFiles = files.filter((f) => f.endsWith('.py'));
    expect([...(result.sourceTexts?.keys() ?? [])].sort()).toEqual(
      pythonFiles.map((f) => f.replace(/\\/g, '/')).sort(),
    );
  });
});
