import { describe, it, expect } from 'vitest';
import {
  detectArtifactFormat,
  isDataArtifact,
  registerDataArtifacts,
  ensureImportTarget,
  inferDataRelationshipType,
  addDataRelationship,
} from './index.js';
import { ConnectionGraph } from '../graph.js';
import { JsTsAnalyzer } from '../analyzer/js-ts-analyzer.js';

describe('Data Format Detection', () => {
  it('detects all supported data formats by extension', () => {
    expect(detectArtifactFormat('data/source.json')).toBe('json');
    expect(detectArtifactFormat('data/lines.jsonl')).toBe('jsonl');
    expect(detectArtifactFormat('data/stream.ndjson')).toBe('jsonl');
    expect(detectArtifactFormat('data/items.csv')).toBe('csv');
    expect(detectArtifactFormat('data/table.tsv')).toBe('tsv');
    expect(detectArtifactFormat('data/titles.parquet')).toBe('parquet');
    expect(detectArtifactFormat('config.yaml')).toBe('yaml');
    expect(detectArtifactFormat('config.yml')).toBe('yaml');
    expect(detectArtifactFormat('Cargo.toml')).toBe('toml');
    expect(detectArtifactFormat('manifest.xml')).toBe('xml');
    expect(detectArtifactFormat('db.sqlite')).toBe('sqlite');
    expect(detectArtifactFormat('db.sqlite3')).toBe('sqlite');
    expect(detectArtifactFormat('data.db')).toBe('sqlite');
  });

  it('returns undefined for non-data files', () => {
    expect(detectArtifactFormat('src/main.ts')).toBeUndefined();
    expect(detectArtifactFormat('README.md')).toBeUndefined();
  });

  it('isDataArtifact checks recognized formats', () => {
    expect(isDataArtifact('data/games.json')).toBe(true);
    expect(isDataArtifact('data/games.parquet')).toBe(true);
    expect(isDataArtifact('src/main.ts')).toBe(false);
  });

  it('registerDataArtifacts adds artifact nodes to ConnectionGraph', () => {
    const graph = new ConnectionGraph();
    const files = ['data/raw.json', 'data/titles.parquet', 'src/main.ts'];

    const registered = registerDataArtifacts(files, graph);

    // JSON is left out until code references it; see ensureImportTarget.
    expect(registered).toEqual(['data/titles.parquet']);
    expect(graph.hasArtifact('data/raw.json')).toBe(false);
    ensureImportTarget(graph, 'data/raw.json');
    expect(graph.getArtifact('data/raw.json')?.format).toBe('json');
    expect(graph.hasArtifact('data/titles.parquet')).toBe(true);
    expect(graph.getArtifact('data/titles.parquet')?.format).toBe('parquet');
    expect(graph.hasArtifact('src/main.ts')).toBe(false);
  });
});

describe('Data Relationship Inference & Graph Registration', () => {
  it('infers generates for write keywords and modes', () => {
    expect(inferDataRelationshipType('fs.writeFileSync("data/out.json", data)')).toBe('generates');
    expect(inferDataRelationshipType('df.to_parquet("data/titles.parquet")')).toBe('generates');
    expect(inferDataRelationshipType('open("data/out.json", "w")')).toBe('generates');
  });

  it('infers consumes for read/load keywords', () => {
    expect(inferDataRelationshipType('fs.readFileSync("data/in.json")')).toBe('consumes');
    expect(inferDataRelationshipType('pd.read_parquet("data/titles.parquet")')).toBe('consumes');
    expect(inferDataRelationshipType('fetch("data/config.yaml")')).toBe('consumes');
  });

  it('defaults to reads for generic references', () => {
    expect(inferDataRelationshipType('const path = "data/raw.json";')).toBe('reads');
  });

  it('stores one forward data relationship, with no reverse link', () => {
    const graph = new ConnectionGraph();
    addDataRelationship('scripts/build.js', 'data/output.parquet', 'generates', graph);

    const rels = graph.getRelationships();
    expect(
      rels.some(
        (r) =>
          r.type === 'generates' && r.from === 'scripts/build.js' && r.to === 'data/output.parquet',
      ),
    ).toBe(true);
    expect(rels).toHaveLength(1);
  });
});

describe('Milestone 3 Success Criterion: Multi-Stage Data Pipeline Graph', () => {
  it('connects script -> JSON -> script -> Parquet -> TypeScript into one connected graph', () => {
    const graph = new ConnectionGraph();
    const analyzer = new JsTsAnalyzer();

    const knownFiles = [
      'scripts/collect.js',
      'scripts/build.js',
      'data/raw.json',
      'data/titles.parquet',
      'src/data/loadTitles.ts',
      'src/pages/TitlesPage.tsx',
    ];

    // Register artifact nodes
    registerDataArtifacts(knownFiles, graph);

    // 1. Collector script (generates raw.json)
    const collectCode = `
      const fs = require('fs');
      fs.writeFileSync('data/raw.json', JSON.stringify({ games: [] }));
    `;
    analyzer.analyzeFile('scripts/collect.js', collectCode, graph, { knownFiles });

    // 2. Build script (consumes raw.json, generates titles.parquet)
    const buildCode = `
      const fs = require('fs');
      const raw = fs.readFileSync('data/raw.json', 'utf8');
      fs.writeFileSync('data/titles.parquet', raw);
    `;
    analyzer.analyzeFile('scripts/build.js', buildCode, graph, { knownFiles });

    // 3. TS data loader (consumes titles.parquet, exports loadTitles)
    const loadTitlesCode = `
      import { readParquet } from './parquet-lib.js';
      export function loadTitles() {
        return readParquet('data/titles.parquet');
      }
    `;
    analyzer.analyzeFile('src/data/loadTitles.ts', loadTitlesCode, graph, { knownFiles });

    // 4. TS UI Page (imports loadTitles, calls loadTitles)
    const pageCode = `
      import { loadTitles } from '../data/loadTitles.js';
      export function TitlesPage() {
        const titles = loadTitles();
        return titles;
      }
    `;
    analyzer.analyzeFile('src/pages/TitlesPage.tsx', pageCode, graph, { knownFiles });

    // Build the connection map
    const map = graph.build({ commit: 'm3test', generatedAt: '2026-10-01T00:00:00Z' });

    // Verify all nodes are present in the map
    expect(map.files['scripts/collect.js']).toBeDefined();
    expect(map.files['scripts/build.js']).toBeDefined();
    expect(map.files['src/data/loadTitles.ts']).toBeDefined();
    expect(map.files['src/pages/TitlesPage.tsx']).toBeDefined();

    expect(map.artifacts['data/raw.json']).toBeDefined();
    expect(map.artifacts['data/raw.json']?.format).toBe('json');
    expect(map.artifacts['data/titles.parquet']).toBeDefined();
    expect(map.artifacts['data/titles.parquet']?.format).toBe('parquet');

    // Verify pipeline relationships in the connection map
    // collect.js -> generates -> data/raw.json
    expect(
      map.relationships.some(
        (r) =>
          r.type === 'generates' && r.from === 'scripts/collect.js' && r.to === 'data/raw.json',
      ),
    ).toBe(true);
    // scripts/build.js -> consumes -> data/raw.json
    expect(
      map.relationships.some(
        (r) => r.type === 'consumes' && r.from === 'scripts/build.js' && r.to === 'data/raw.json',
      ),
    ).toBe(true);
    // build.js -> generates -> data/titles.parquet
    expect(
      map.relationships.some(
        (r) =>
          r.type === 'generates' && r.from === 'scripts/build.js' && r.to === 'data/titles.parquet',
      ),
    ).toBe(true);
    // src/data/loadTitles.ts -> consumes -> data/titles.parquet
    expect(
      map.relationships.some(
        (r) =>
          r.type === 'consumes' &&
          r.from === 'src/data/loadTitles.ts' &&
          r.to === 'data/titles.parquet',
      ),
    ).toBe(true);
    // TitlesPage.tsx -> calls -> src/data/loadTitles.ts:loadTitles
    expect(
      map.relationships.some(
        (r) =>
          r.type === 'calls' &&
          r.from === 'src/pages/TitlesPage.tsx:TitlesPage' &&
          r.to === 'src/data/loadTitles.ts:loadTitles',
      ),
    ).toBe(true);
  });
});
