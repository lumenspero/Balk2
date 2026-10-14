import { describe, it, expect } from 'vitest';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { resolveImportPath } from './resolver.js';
import { ConnectionGraph } from '../graph.js';
import { getIncoming } from '../graph-queries.js';
import { storedReverseTypes } from '../testing/legacy-maps.js';

describe('resolveImportPath', () => {
  const knownFiles = new Set([
    'src/main.ts',
    'src/util.ts',
    'src/components/Button.tsx',
    'src/state/index.ts',
    'scripts/build.js',
  ]);

  it('resolves relative import with .js extension to .ts file in knownFiles', () => {
    expect(resolveImportPath('src/main.ts', './util.js', knownFiles)).toBe('src/util.ts');
  });

  it('resolves relative import without extension to .tsx file in knownFiles', () => {
    expect(resolveImportPath('src/main.ts', './components/Button', knownFiles)).toBe(
      'src/components/Button.tsx',
    );
  });

  it('resolves index file fallback', () => {
    expect(resolveImportPath('src/main.ts', './state', knownFiles)).toBe('src/state/index.ts');
  });

  it('returns undefined for non-relative package imports', () => {
    expect(resolveImportPath('src/main.ts', 'react', knownFiles)).toBeUndefined();
    expect(resolveImportPath('src/main.ts', 'node:fs', knownFiles)).toBeUndefined();
  });

  it('handles parent directory navigation (../)', () => {
    expect(resolveImportPath('src/components/Button.tsx', '../util.js', knownFiles)).toBe(
      'src/util.ts',
    );
  });
});

describe('JsTsAnalyzer', () => {
  const analyzer = new JsTsAnalyzer();

  describe('canAnalyze', () => {
    it('supports JS, JSX, TS, TSX, MJS, CJS', () => {
      expect(analyzer.canAnalyze('src/main.ts')).toBe(true);
      expect(analyzer.canAnalyze('src/App.tsx')).toBe(true);
      expect(analyzer.canAnalyze('src/index.js')).toBe(true);
      expect(analyzer.canAnalyze('src/Component.jsx')).toBe(true);
      expect(analyzer.canAnalyze('scripts/build.mjs')).toBe(true);
      expect(analyzer.canAnalyze('config.cjs')).toBe(true);
    });

    it('rejects unsupported extensions', () => {
      expect(analyzer.canAnalyze('scripts/collect.py')).toBe(false);
      expect(analyzer.canAnalyze('data/source.json')).toBe(false);
      expect(analyzer.canAnalyze('README.md')).toBe(false);
    });
  });

  describe('file and language analysis', () => {
    it('detects typescript language for .ts/.tsx', () => {
      const graph = new ConnectionGraph();
      analyzer.analyzeFile('src/main.ts', 'const x = 1;', graph);

      expect(graph.getFile('src/main.ts')).toEqual({
        kind: 'file',
        path: 'src/main.ts',
        language: 'typescript',
      });
    });

    it('detects javascript language for .js/.jsx/.mjs/.cjs', () => {
      const graph = new ConnectionGraph();
      analyzer.analyzeFile('scripts/build.js', 'const x = 1;', graph);

      expect(graph.getFile('scripts/build.js')).toEqual({
        kind: 'file',
        path: 'scripts/build.js',
        language: 'javascript',
      });
    });
  });

  describe('imports and exports', () => {
    it('extracts named and default imports and re-exports', () => {
      const graph = new ConnectionGraph();
      const knownFiles = ['src/main.ts', 'src/util.ts'];

      const code = `
        import { formatDate, parseNumber } from './util.js';
        import defaultLogger from './util.js';
        export { formatDate };
      `;

      analyzer.analyzeFile('src/main.ts', code, graph, { knownFiles });

      const rels = graph.getRelationships();
      expect(
        rels.some(
          (r) => r.type === 'imports' && r.from === 'src/main.ts' && r.to === 'src/util.ts',
        ),
      ).toBe(true);
      // The reverse is derived, not stored.
      const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
      expect(getIncoming(map, 'src/util.ts', 'imports').map((r) => r.from)).toEqual([
        'src/main.ts',
      ]);
      expect(storedReverseTypes(map)).toEqual([]);
    });

    it('extracts CommonJS require statements', () => {
      const graph = new ConnectionGraph();
      const knownFiles = ['src/main.js', 'src/config.js'];

      const code = `
        const config = require('./config.js');
      `;

      analyzer.analyzeFile('src/main.js', code, graph, { knownFiles });

      const rels = graph.getRelationships();
      expect(
        rels.some(
          (r) => r.type === 'imports' && r.from === 'src/main.js' && r.to === 'src/config.js',
        ),
      ).toBe(true);
    });
  });

  describe('symbols and exports', () => {
    it('extracts exported and internal functions, classes, methods, and types', () => {
      const graph = new ConnectionGraph();

      const code = `
        export function startSim() {}
        function internalHelper() {}

        export class Simulator {
          step() {}
        }

        export type SimState = { active: boolean };
        export interface Config { timeout: number; }
        export const MAX_RETRY = 3;
      `;

      analyzer.analyzeFile('src/sim.ts', code, graph);

      expect(graph.hasSymbol('src/sim.ts:startSim')).toBe(true);
      expect(graph.hasSymbol('src/sim.ts:internalHelper')).toBe(true);
      expect(graph.hasSymbol('src/sim.ts:Simulator')).toBe(true);
      expect(graph.hasSymbol('src/sim.ts:Simulator.step')).toBe(true);
      expect(graph.hasSymbol('src/sim.ts:SimState')).toBe(true);
      expect(graph.hasSymbol('src/sim.ts:Config')).toBe(true);
      expect(graph.hasSymbol('src/sim.ts:MAX_RETRY')).toBe(true);

      const exportsRels = graph.getRelationships('src/sim.ts').filter((r) => r.type === 'exports');
      expect(exportsRels).toHaveLength(5);
    });
  });

  describe('inheritance and call relationships', () => {
    it('extracts extends, implements, and calls, with callers derived', () => {
      const graph = new ConnectionGraph();
      const knownFiles = ['src/app.ts', 'src/base.ts'];

      const code = `
        import { BaseService, stepSimulation } from './base.js';

        export class AppService extends BaseService {
          run() {
            stepSimulation();
          }
        }
      `;

      analyzer.analyzeFile('src/app.ts', code, graph, { knownFiles });

      const rels = graph.getRelationships();

      // Class extends
      expect(
        rels.some(
          (r) =>
            r.type === 'extends' &&
            r.from === 'src/app.ts:AppService' &&
            r.to === 'src/base.ts:BaseService',
        ),
      ).toBe(true);

      // Method calls imported function
      expect(
        rels.some(
          (r) =>
            r.type === 'calls' &&
            r.from === 'src/app.ts:AppService.run' &&
            r.to === 'src/base.ts:stepSimulation',
        ),
      ).toBe(true);
      // The reverse is derived, not stored.
      const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });
      expect(getIncoming(map, 'src/base.ts:stepSimulation', 'calls').map((r) => r.from)).toEqual([
        'src/app.ts:AppService.run',
      ]);
      expect(storedReverseTypes(map)).toEqual([]);
    });
  });

  describe('multi-file analysis scenario', () => {
    it('analyzes connected files and establishes complete code dependency graph', () => {
      const graph = new ConnectionGraph();
      const knownFiles = ['src/state.ts', 'src/sim.ts', 'src/main.ts'];

      const simCode = `
        export function stepSim() { return 42; }
      `;

      const stateCode = `
        import { stepSim } from './sim.js';
        export function updateState() {
          stepSim();
        }
      `;

      const mainCode = `
        import { updateState } from './state.js';
        export function main() {
          updateState();
        }
      `;

      analyzer.analyzeFile('src/sim.ts', simCode, graph, { knownFiles });
      analyzer.analyzeFile('src/state.ts', stateCode, graph, { knownFiles });
      analyzer.analyzeFile('src/main.ts', mainCode, graph, { knownFiles });

      expect(graph.nodeCount).toBe(6); // 3 files + 3 symbols

      const map = graph.build({ generatedAt: '2026-01-01T00:00:00Z' });

      expect(map.files['src/sim.ts']).toBeDefined();
      expect(map.files['src/state.ts']).toBeDefined();
      expect(map.files['src/main.ts']).toBeDefined();

      expect(map.symbols['src/sim.ts:stepSim']).toBeDefined();
      expect(map.symbols['src/state.ts:updateState']).toBeDefined();
      expect(map.symbols['src/main.ts:main']).toBeDefined();

      // Check call chain
      expect(
        map.relationships.some(
          (r) =>
            r.type === 'calls' &&
            r.from === 'src/main.ts:main' &&
            r.to === 'src/state.ts:updateState',
        ),
      ).toBe(true);
      expect(
        map.relationships.some(
          (r) =>
            r.type === 'calls' &&
            r.from === 'src/state.ts:updateState' &&
            r.to === 'src/sim.ts:stepSim',
        ),
      ).toBe(true);
    });
  });
});
