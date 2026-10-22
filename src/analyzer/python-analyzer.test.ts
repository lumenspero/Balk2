import { describe, it, expect } from 'vitest';
import { PythonAnalyzer } from './python-analyzer.js';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { ConnectionGraph } from '../graph.js';
import { renderMarkdown } from '../renderer/markdown-renderer.js';
import { registerDataArtifacts } from '../data/formats.js';

describe('PythonAnalyzer', () => {
  const analyzer = new PythonAnalyzer();

  describe('canAnalyze', () => {
    it('supports .py files', () => {
      expect(analyzer.canAnalyze('scripts/collect.py')).toBe(true);
      expect(analyzer.canAnalyze('main.py')).toBe(true);
    });

    it('rejects non-python files', () => {
      expect(analyzer.canAnalyze('src/main.ts')).toBe(false);
      expect(analyzer.canAnalyze('data/raw.json')).toBe(false);
    });
  });

  describe('file and symbol extraction', () => {
    it('extracts python file node with python language classification', () => {
      const graph = new ConnectionGraph();
      analyzer.analyzeFile('scripts/collect.py', 'print("hello")', graph);

      expect(graph.getFile('scripts/collect.py')).toEqual({
        kind: 'file',
        path: 'scripts/collect.py',
        language: 'python',
      });
    });

    it('extracts top-level functions, classes, methods, constants, and exports', () => {
      const graph = new ConnectionGraph();

      const pythonCode = `
MAX_RETRIES = 3

class Pipeline:
    def process(self):
        pass

def start_pipeline():
    p = Pipeline()
    p.process()
`;

      analyzer.analyzeFile('scripts/pipeline.py', pythonCode, graph);

      expect(graph.hasSymbol('scripts/pipeline.py:MAX_RETRIES')).toBe(true);
      expect(graph.hasSymbol('scripts/pipeline.py:Pipeline')).toBe(true);
      expect(graph.hasSymbol('scripts/pipeline.py:Pipeline.process')).toBe(true);
      expect(graph.hasSymbol('scripts/pipeline.py:start_pipeline')).toBe(true);

      const exportsRels = graph
        .getRelationships('scripts/pipeline.py')
        .filter((r) => r.type === 'exports');
      expect(exportsRels).toHaveLength(3); // MAX_RETRIES, Pipeline, start_pipeline
    });

    it('extracts class extends relationship', () => {
      const graph = new ConnectionGraph();
      const code = `
class BaseService:
    pass

class CustomService(BaseService):
    pass
`;
      analyzer.analyzeFile('scripts/service.py', code, graph);

      const rels = graph.getRelationships('scripts/service.py:CustomService');
      expect(
        rels.some(
          (r) =>
            r.type === 'extends' &&
            r.from === 'scripts/service.py:CustomService' &&
            r.to === 'scripts/service.py:BaseService',
        ),
      ).toBe(true);
    });

    it('extracts data artifact references in python code', () => {
      const graph = new ConnectionGraph();
      const code = `
import json

def run():
    with open('data/raw.json', 'w') as f:
        json.dump({}, f)
`;

      analyzer.analyzeFile('scripts/collect.py', code, graph);

      const rels = graph.getRelationships();
      expect(
        rels.some(
          (r) =>
            r.type === 'generates' && r.from === 'scripts/collect.py' && r.to === 'data/raw.json',
        ),
      ).toBe(true);
    });
  });

  describe('Milestone 7 Success Criterion: Python + TypeScript Unified Connection Map', () => {
    it('connects Python pipeline and TypeScript application into ONE unified graph', () => {
      const graph = new ConnectionGraph();
      const pyAnalyzer = new PythonAnalyzer();
      const jsTsAnalyzer = new JsTsAnalyzer();

      const knownFiles = [
        'scripts/collect.py',
        'scripts/normalize.py',
        'scripts/build_parquet.py',
        'data/raw.json',
        'data/normalized.json',
        'data/titles.parquet',
        'src/data/loadTitles.ts',
        'src/pages/TitlesPage.tsx',
      ];

      registerDataArtifacts(knownFiles, graph);

      // 1. Python collector (generates raw.json)
      const collectPy = `
def collect():
    with open('data/raw.json', 'w') as f:
        f.write("{}")
`;
      pyAnalyzer.analyzeFile('scripts/collect.py', collectPy, graph, { knownFiles });

      // 2. Python normalizer (consumes raw.json, generates normalized.json)
      const normPy = `
def normalize():
    with open('data/raw.json', 'r') as f:
        data = f.read()
    with open('data/normalized.json', 'w') as f:
        f.write(data)
`;
      pyAnalyzer.analyzeFile('scripts/normalize.py', normPy, graph, { knownFiles });

      // 3. Python parquet builder (consumes normalized.json, generates titles.parquet)
      const buildPy = `
import pandas as pd

def build():
    df = pd.read_json('data/normalized.json')
    df.to_parquet('data/titles.parquet')
`;
      pyAnalyzer.analyzeFile('scripts/build_parquet.py', buildPy, graph, { knownFiles });

      // 4. TypeScript data loader (consumes titles.parquet, exports loadTitles)
      const loadTitlesTs = `
import { readParquet } from './parquet.js';
export function loadTitles() {
  return readParquet('data/titles.parquet');
}
`;
      jsTsAnalyzer.analyzeFile('src/data/loadTitles.ts', loadTitlesTs, graph, { knownFiles });

      // 5. TypeScript page component (imports loadTitles, calls loadTitles)
      const pageTsx = `
import { loadTitles } from '../data/loadTitles.js';
export function TitlesPage() {
  return loadTitles();
}
`;
      jsTsAnalyzer.analyzeFile('src/pages/TitlesPage.tsx', pageTsx, graph, { knownFiles });

      // Build unified ConnectionMap
      const map = graph.build({ commit: 'unified-m7', generatedAt: '2026-10-01T00:00:00Z' });

      // Verify files in unified map
      expect(map.files['scripts/collect.py']?.language).toBe('python');
      expect(map.files['scripts/normalize.py']?.language).toBe('python');
      expect(map.files['scripts/build_parquet.py']?.language).toBe('python');
      expect(map.files['src/data/loadTitles.ts']?.language).toBe('typescript');
      expect(map.files['src/pages/TitlesPage.tsx']?.language).toBe('typescript');

      // Verify data artifacts in unified map
      expect(map.artifacts['data/raw.json']?.format).toBe('json');
      expect(map.artifacts['data/normalized.json']?.format).toBe('json');
      expect(map.artifacts['data/titles.parquet']?.format).toBe('parquet');

      // Verify full cross-language pipeline relationships
      expect(
        map.relationships.some(
          (r) =>
            r.type === 'generates' && r.from === 'scripts/collect.py' && r.to === 'data/raw.json',
        ),
      ).toBe(true);
      expect(
        map.relationships.some(
          (r) =>
            r.type === 'consumes' && r.from === 'scripts/normalize.py' && r.to === 'data/raw.json',
        ),
      ).toBe(true);
      expect(
        map.relationships.some(
          (r) =>
            r.type === 'generates' &&
            r.from === 'scripts/normalize.py' &&
            r.to === 'data/normalized.json',
        ),
      ).toBe(true);
      expect(
        map.relationships.some(
          (r) =>
            r.type === 'consumes' &&
            r.from === 'scripts/build_parquet.py' &&
            r.to === 'data/normalized.json',
        ),
      ).toBe(true);
      expect(
        map.relationships.some(
          (r) =>
            r.type === 'generates' &&
            r.from === 'scripts/build_parquet.py' &&
            r.to === 'data/titles.parquet',
        ),
      ).toBe(true);
      expect(
        map.relationships.some(
          (r) =>
            r.type === 'consumes' &&
            r.from === 'src/data/loadTitles.ts' &&
            r.to === 'data/titles.parquet',
        ),
      ).toBe(true);
      expect(
        map.relationships.some(
          (r) =>
            r.type === 'calls' &&
            r.from === 'src/pages/TitlesPage.tsx:TitlesPage' &&
            r.to === 'src/data/loadTitles.ts:loadTitles',
        ),
      ).toBe(true);

      // Verify rendering to unified Markdown connection map
      const md = renderMarkdown(map);

      expect(md).toContain('# Repository Connection Map');
      expect(md).toContain('scripts/collect.py (python)');
      expect(md).toContain('src/data/loadTitles.ts (typescript)');
      expect(md).toContain('### data/titles.parquet (parquet)');
      expect(md).toContain('Generated by:');
      expect(md).toContain('  ← scripts/build_parquet.py');
      expect(md).toContain('Consumed by:');
      expect(md).toContain('  → src/data/loadTitles.ts');
    });
  });
});
