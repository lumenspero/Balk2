import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import type { Relationship } from '../types.js';
import { collectGlobalSymbols, type GlobalFact, type GlobalSymbol } from './global-symbols.js';
import { JsTsAnalyzer, type RepositoryAnalysisOptions } from './js-ts-analyzer.js';
import { createRepositoryProgram, type RepositoryProgram } from './repository-program.js';

// Each case builds one or two TypeScript programs; the default 5s limit is too tight when the
// whole suite runs in parallel on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const TSCONFIGS: ReadonlyArray<readonly [string, Record<string, unknown> | undefined]> = [
  ['no tsconfig (node16 defaults)', undefined],
  ['esnext + bundler', { module: 'ESNext', moduleResolution: 'Bundler' }],
];

describe.each(TSCONFIGS)('Phase 3: global facts and policy [%s]', (_label, compilerOptions) => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-facts-test-'));
    if (compilerOptions) {
      fs.writeFileSync(
        path.join(rootDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions }),
        'utf8',
      );
    }
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  function open(files: Record<string, string>): RepositoryProgram {
    for (const [name, content] of Object.entries(files)) {
      const full = path.join(rootDir, name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    return createRepositoryProgram({ rootDir, filePaths: Object.keys(files).sort() });
  }

  interface AnalysisResult {
    readonly graph: ConnectionGraph;
    readonly facts: readonly GlobalFact[];
    readonly references: readonly Relationship[];
    readonly has: (from: string, to: string) => boolean;
    readonly factsIn: (filePath: string) => readonly GlobalFact[];
  }

  function analyze(
    files: Record<string, string>,
    options?: RepositoryAnalysisOptions,
  ): AnalysisResult {
    const graph = new ConnectionGraph();
    const { globalFacts } = new JsTsAnalyzer().analyzeRepository(open(files), graph, options);
    const references = graph.getRelationships().filter((r) => r.type === 'references');
    return {
      graph,
      facts: globalFacts,
      references,
      has: (from: string, to: string): boolean =>
        references.some((r) => r.from === from && r.to === to),
      factsIn: (filePath: string): readonly GlobalFact[] =>
        globalFacts.filter((fact) => fact.location.filePath === filePath),
    };
  }

  const kinds = (facts: readonly GlobalFact[]): string[] =>
    facts.map((fact) => `${fact.kind}:${fact.name}`);

  describe('declaration versus runtime write', () => {
    it('lets a top-level assignment declare the global while in-function writes are only facts', () => {
      const { graph, has, factsIn } = analyze({
        'a.js': 'window.counter = 0;',
        'b.js': 'export function inc() { window.counter = window.counter + 1; }',
        'c.js': 'export function show() { return counter; }',
      });

      expect(has('c.js:show', 'a.js:counter')).toBe(true);
      expect(has('b.js:inc', 'a.js:counter')).toBe(true); // the read in `counter + 1`
      expect(graph.hasSymbol('b.js:counter')).toBe(false);

      expect(factsIn('a.js').map((f) => f.kind)).toEqual(['declare']);
      const bFacts = factsIn('b.js');
      expect(kinds(bFacts)).toEqual(['write:counter', 'read:counter']);
      expect(bFacts.every((f) => f.targetSymbolId === 'a.js:counter')).toBe(true);
    });

    it('falls back to in-function assignments when no top-level origin exists', () => {
      const { has } = analyze({
        'a.js': '(function () { window.App = {}; })();',
        'b.js': 'export function run() { return App; }',
      });
      expect(has('b.js:run', 'a.js:App')).toBe(true);
    });
  });

  describe('independent facts', () => {
    it('reports reads, writes, read-writes and deletes separately', () => {
      const { has, references, factsIn } = analyze({
        'lib.js': 'window.flag = 0;\nwindow.n = 0;',
        'use.js': [
          'export function f() {',
          '  window.flag = 1;',
          '  window.n += 1;',
          '  delete window.flag;',
          '  return window.flag;',
          '}',
        ].join('\n'),
        'w.js': 'export function g() { window.flag = 1; }',
      });

      expect(kinds(factsIn('use.js'))).toEqual([
        'write:flag',
        'read:n',
        'write:n',
        'delete:flag',
        'read:flag',
      ]);
      expect(has('use.js:f', 'lib.js:flag')).toBe(true);
      expect(has('use.js:f', 'lib.js:n')).toBe(true);

      // A write alone is a fact, not a dependency edge.
      expect(references.filter((r) => r.from === 'w.js:g')).toEqual([]);
      expect(kinds(factsIn('w.js'))).toEqual(['write:flag']);
    });

    it('reports script declarations as declare facts', () => {
      const { facts } = analyze({ 's.ts': 'function boot() {}' });
      expect(facts).toEqual([
        expect.objectContaining({ kind: 'declare', name: 'boot', owner: 's.ts:boot' }),
      ]);
    });

    it('counts an initializer or default parameter as a use', () => {
      const { has } = analyze({
        'lib.ts': 'function boot() {}',
        'main.ts': 'export const handler = boot;\nexport function f(a = boot) { return a; }',
      });
      expect(has('main.ts', 'lib.ts:boot')).toBe(true);
      expect(has('main.ts:f', 'lib.ts:boot')).toBe(true);
    });
  });

  describe('duplicate names', () => {
    const files = {
      'one.js': 'window.shared = 1;',
      'two.js': 'window.shared = 2;',
      'use.js': 'export function f() { return shared; }',
    };

    it('records an ambiguous low-confidence observation with candidate origins and no edge', () => {
      const { references, factsIn } = analyze(files);

      expect(references.filter((r) => r.from === 'use.js:f')).toEqual([]);
      expect(factsIn('use.js')).toEqual([
        expect.objectContaining({
          kind: 'read',
          name: 'shared',
          resolution: 'ambiguous',
          confidence: 'low',
          candidates: ['one.js:shared', 'two.js:shared'],
          owner: 'use.js:f',
        }),
      ]);
      expect(factsIn('use.js')[0]?.targetSymbolId).toBeUndefined();
    });

    it('keeps both establishing sites as declare facts', () => {
      const { facts } = analyze(files);
      expect(facts.filter((f) => f.kind === 'declare').map((f) => f.targetSymbolId)).toEqual([
        'one.js:shared',
        'two.js:shared',
      ]);
    });

    it('resolves to the configured target file', () => {
      const { has, factsIn } = analyze(files, {
        globals: { targets: { shared: 'two.js' } },
      });

      expect(has('use.js:f', 'two.js:shared')).toBe(true);
      expect(has('use.js:f', 'one.js:shared')).toBe(false);
      expect(factsIn('use.js')[0]).toMatchObject({
        resolution: 'selected',
        confidence: 'high',
        targetSymbolId: 'two.js:shared',
      });
    });

    it('ignores a configured target that matches no candidate', () => {
      const { references } = analyze(files, { globals: { targets: { shared: 'nowhere.js' } } });
      expect(references.filter((r) => r.from === 'use.js:f')).toEqual([]);
    });
  });

  describe('configured roots', () => {
    const files = {
      'a.js': 'window.x = 1;',
      'b.js': 'export function f() { return x; }',
    };

    it('treats window as a root by default', () => {
      expect(analyze(files).has('b.js:f', 'a.js:x')).toBe(true);
    });

    it('replaces the default roots when configured', () => {
      const { has } = analyze(files, { globals: { roots: ['globalThis'] } });
      expect(has('b.js:f', 'a.js:x')).toBe(false);
    });

    it('accepts a custom root', () => {
      const { has } = analyze(
        { 'a.js': 'frameworkRoot.x = 1;', 'b.js': files['b.js'] },
        { globals: { roots: ['frameworkRoot'] } },
      );
      expect(has('b.js:f', 'a.js:x')).toBe(true);
    });
  });

  describe('symbol metadata', () => {
    it('records scope, exported status and write location', () => {
      const index = collectGlobalSymbols(
        open({
          'a.ts': 'export class App {}\nwindow.App = App;\nfunction init() { window.Late = 1; }',
          's.ts': 'function boot() {}',
        }),
      );
      const byName = (name: string): GlobalSymbol | undefined =>
        index.all().find((symbol) => symbol.name === name);

      expect(byName('App')).toMatchObject({
        scope: 'top-level',
        exported: true,
        location: { filePath: 'a.ts', line: 2, column: 1 },
      });
      expect(byName('Late')).toMatchObject({
        scope: 'function',
        exported: false,
        location: { filePath: 'a.ts', line: 3, column: 19 },
      });
      expect(byName('boot')).toMatchObject({
        scope: 'top-level',
        exported: false,
        location: { filePath: 's.ts', line: 1, column: 10 },
      });
    });
  });
});
