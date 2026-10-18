import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { loadBalk2Config, loadBalk2ConfigDetailed } from './balk2-config.js';
import { applyExplicitLineage } from './lineage-processor.js';
import { filterFilesWithConfig, matchPattern } from './file-matcher.js';
import { ConnectionGraph } from '../graph.js';
import { generateConnectionMap } from '../cli/generate.js';

describe('.balk2.json Configuration & Data Lineage', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-config-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe('loadBalk2Config', () => {
    it('loads and parses .balk2.json from workspace', () => {
      const configData = {
        include: ['src/**', 'scripts/**'],
        exclude: ['dist/**'],
        output: 'custom-map',
        data: {
          lineage: [{ producer: 'scripts/collect.py', output: 'data/games.json' }],
        },
      };

      fs.writeFileSync(path.join(tmpDir, '.balk2.json'), JSON.stringify(configData, null, 2));

      const config = loadBalk2Config(tmpDir);
      expect(config).toBeDefined();
      expect(config?.include).toEqual(['src/**', 'scripts/**']);
      expect(config?.output).toBe('custom-map');
      expect(config?.data?.lineage).toHaveLength(1);
    });

    it('reports keys in data that are not read, such as data.extensions from 1.x', () => {
      fs.writeFileSync(
        path.join(tmpDir, '.balk2.json'),
        JSON.stringify({ data: { extensions: ['.json'], lineage: [] } }),
      );

      const { problems } = loadBalk2ConfigDetailed(tmpDir);
      expect(problems).toEqual([{ path: 'data.extensions', message: 'unknown key ignored' }]);
    });

    it('returns undefined if .balk2.json does not exist', () => {
      expect(loadBalk2Config(tmpDir)).toBeUndefined();
    });
  });

  describe('file-matcher', () => {
    it('matches glob patterns correctly', () => {
      expect(matchPattern('src/main.ts', 'src/**')).toBe(true);
      expect(matchPattern('node_modules/lodash/index.js', 'node_modules/**')).toBe(true);
      expect(matchPattern('scripts/build.js', 'scripts/*')).toBe(true);
    });

    it('filters files according to include and exclude rules', () => {
      const files = [
        'src/main.ts',
        'src/util.ts',
        'node_modules/pkg/index.js',
        'dist/main.js',
        'scripts/collect.py',
      ];

      const filtered = filterFilesWithConfig(
        files,
        ['src/**', 'scripts/**'],
        ['node_modules/**', 'dist/**'],
      );

      expect(filtered).toEqual(['src/main.ts', 'src/util.ts', 'scripts/collect.py']);
    });
  });

  describe('applyExplicitLineage', () => {
    it('populates ConnectionGraph with explicit producer/consumer data flow rules', () => {
      const graph = new ConnectionGraph();

      const lineage = [
        {
          producer: 'scripts/collect.py',
          output: 'data/games.json',
        },
        {
          producer: 'scripts/build_parquet.py',
          input: 'data/games.json',
          output: 'data/games.parquet',
        },
        {
          consumer: 'src/data/loadGames.ts',
          input: 'data/games.parquet',
        },
      ];

      applyExplicitLineage(lineage, graph);

      const rels = graph.getRelationships();

      // Producer outputs
      expect(
        rels.some(
          (r) =>
            r.type === 'generates' && r.from === 'scripts/collect.py' && r.to === 'data/games.json',
        ),
      ).toBe(true);

      // Producer inputs & outputs
      expect(
        rels.some(
          (r) =>
            r.type === 'consumes' &&
            r.from === 'scripts/build_parquet.py' &&
            r.to === 'data/games.json',
        ),
      ).toBe(true);
      expect(
        rels.some(
          (r) =>
            r.type === 'generates' &&
            r.from === 'scripts/build_parquet.py' &&
            r.to === 'data/games.parquet',
        ),
      ).toBe(true);

      // Consumer inputs
      expect(
        rels.some(
          (r) =>
            r.type === 'consumes' &&
            r.from === 'src/data/loadGames.ts' &&
            r.to === 'data/games.parquet',
        ),
      ).toBe(true);
    });
  });

  describe('Milestone 6 Integration Scenario', () => {
    it('generates connection map honoring .balk2.json config and explicit lineage', () => {
      // 1. Setup repo with .balk2.json
      const balk2Config = {
        output: 'connection-map',
        data: {
          lineage: [
            {
              producer: 'scripts/collect.py',
              output: 'data/games.json',
            },
            {
              producer: 'scripts/build_parquet.py',
              input: 'data/games.json',
              output: 'data/games.parquet',
            },
            {
              consumer: 'src/data/loadGames.ts',
              input: 'data/games.parquet',
            },
          ],
        },
      };

      fs.writeFileSync(path.join(tmpDir, '.balk2.json'), JSON.stringify(balk2Config, null, 2));

      // Setup source files
      const srcDataDir = path.join(tmpDir, 'src', 'data');
      fs.mkdirSync(srcDataDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDataDir, 'loadGames.ts'),
        'export function loadGames() { return []; }',
      );

      // Run generator
      const res = generateConnectionMap({ cwd: tmpDir, timestamp: '2026-10-01T00:00:00Z' });

      expect(fs.existsSync(res.jsonPath)).toBe(true);
      expect(fs.existsSync(res.mdPath)).toBe(true);

      const jsonContent = fs.readFileSync(res.jsonPath, 'utf8');
      expect(jsonContent).toContain('"scripts/collect.py"');
      expect(jsonContent).toContain('"data/games.json"');
      expect(jsonContent).toContain('"data/games.parquet"');

      const mdContent = fs.readFileSync(res.mdPath, 'utf8');
      expect(mdContent).toContain('## Data Connections');
      expect(mdContent).toContain('### data/games.json (json)');
      expect(mdContent).toContain('Generated by:');
      expect(mdContent).toContain('  ← scripts/collect.py');
    });
  });
});
