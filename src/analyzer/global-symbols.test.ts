import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import type { Relationship } from '../types.js';
import { collectGlobalSymbols } from './global-symbols.js';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import type { RepositoryProgram } from './repository-program.js';

// Each case builds one or two TypeScript programs; the default 5s limit is too tight when the
// whole suite runs in parallel on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

/**
 * The checker classifies files differently per compiler setting (under node16 every
 * file is a module; under esnext script files are real scripts), so the whole suite runs
 * against each of these. CommonJS with node10 classifies files exactly as esnext does, so it
 * adds no coverage.
 */
const TSCONFIGS: ReadonlyArray<readonly [string, Record<string, unknown> | undefined]> = [
  ['no tsconfig (node16 defaults)', undefined],
  ['esnext + bundler', { module: 'ESNext', moduleResolution: 'Bundler' }],
];

describe.each(TSCONFIGS)('Phase 3: global symbol traversal [%s]', (_label, compilerOptions) => {
  const fixtures: RepositoryFixture[] = [];

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup();
  });

  function open(files: Record<string, string>): RepositoryProgram {
    const fixture = createRepositoryFixture(files, compilerOptions);
    fixtures.push(fixture);
    return fixture.repository;
  }

  interface AnalysisResult {
    readonly graph: ConnectionGraph;
    readonly references: readonly Relationship[];
    readonly has: (from: string, to: string) => boolean;
  }

  function analyze(files: Record<string, string>): AnalysisResult {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(open(files), graph);
    const references = graph.getRelationships().filter((r) => r.type === 'references');
    return {
      graph,
      references,
      has: (from: string, to: string): boolean =>
        references.some((r) => r.from === from && r.to === to),
    };
  }

  describe('collection pass', () => {
    it('collects script-scope declarations but not ES module declarations', () => {
      const index = collectGlobalSymbols(
        open({
          'a.ts': 'function scriptFn() {}\nvar scriptVar = 1;',
          'b.ts': 'export {};\nfunction moduleFn() {}',
        }),
      );
      expect(index.all().map((s) => s.name)).toEqual(['scriptFn', 'scriptVar']);
    });

    it('does not treat CommonJS file declarations as globals', () => {
      const index = collectGlobalSymbols(
        open({ 'a.js': 'function helper() {}\nmodule.exports = { helper };' }),
      );
      expect(index.all().map((s) => s.name)).not.toContain('helper');
    });

    it('treats .mjs and .cts files as modules, so their declarations are not globals', () => {
      const index = collectGlobalSymbols(
        open({
          'a.mjs': 'function fromMjs() {}',
          'b.cts': 'function fromCts() {}',
        }),
      );
      expect(index.all()).toEqual([]);
    });

    it('ignores assignments through a computed key, which name no global', () => {
      const index = collectGlobalSymbols(
        open({
          'a.js': 'export {};\nfunction f(key) { window[key] = 1; window[key + 1].x = 2; }',
        }),
      );
      expect(index.all()).toEqual([]);
    });

    it('does not treat a bare assignment to a global root as a named global', () => {
      const index = collectGlobalSymbols(open({ 'a.js': 'export {};\nwindow = {};' }));
      expect(index.all()).toEqual([]);
    });

    it('collects declarations inside `declare global`', () => {
      const index = collectGlobalSymbols(
        open({ 'a.ts': 'export {};\ndeclare global { function ext(): void; }' }),
      );
      const ext = index.all().find((s) => s.name === 'ext');
      expect(ext?.origin).toBe('ambient');
    });

    it('collects explicit assignments to global roots with static paths', () => {
      const index = collectGlobalSymbols(
        open({
          'a.js': 'window.Engine = function () {};\nglobalThis.App.Engine = class {};',
        }),
      );
      expect(
        index
          .all()
          .map((s) => s.name)
          .sort(),
      ).toEqual(['App.Engine', 'Engine']);
    });

    it('ignores assignments whose root only looks like a global root', () => {
      const index = collectGlobalSymbols(
        open({
          'a.js': [
            'export {};',
            'function f(self) { self.handler = 1; }',
            'function g() { const window = {}; window.panel = 1; }',
          ].join('\n'),
        }),
      );
      expect(index.all()).toEqual([]);
    });

    it('resolves statically established aliases of a global root', () => {
      const index = collectGlobalSymbols(
        open({ 'a.js': 'export {};\nconst root = globalThis;\nroot.Shared = function () {};' }),
      );
      expect(index.all().map((s) => s.name)).toEqual(['Shared']);
    });

    it('treats overloads of one function as a single declaration', () => {
      const index = collectGlobalSymbols(
        open({
          'a.ts':
            'function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: any) {}',
        }),
      );
      expect(index.resolve('f')?.symbolId).toBe('a.ts:f');
    });
  });

  describe('resolution pass', () => {
    it('links a module symbol to a script global in another file', () => {
      const { has } = analyze({
        'lib.ts': 'function boot() {}',
        'main.ts': 'export function run() { boot(); }',
      });
      expect(has('main.ts:run', 'lib.ts:boot')).toBe(true);
      expect(has('main.ts', 'lib.ts')).toBe(true);
    });

    it('links uses of an assigned global, bare and through a root', () => {
      const { has } = analyze({
        'lib.js': 'window.Engine = function () {};\nglobalThis.App.Engine = {};',
        'bare.js': 'export function a() { Engine(); }',
        'rooted.js': 'export function b() { return window.App.Engine; }',
      });
      expect(has('bare.js:a', 'lib.js:Engine')).toBe(true);
      expect(has('rooted.js:b', 'lib.js:App.Engine')).toBe(true);
    });

    it('attributes references inside arrow-function and class owners to that owner', () => {
      const { has } = analyze({
        'lib.ts': 'function boot() {}',
        'arrow.ts': 'export const handler = () => { boot(); };',
        'cls.ts': 'export class Svc { start() { boot(); } }',
      });
      expect(has('arrow.ts:handler', 'lib.ts:boot')).toBe(true);
      expect(has('cls.ts:Svc.start', 'lib.ts:boot')).toBe(true);
    });

    it('resolves references to `declare global` symbols', () => {
      const { has } = analyze({
        'types.ts': 'export {};\ndeclare global { function ext(): void; }',
        'main.ts': 'export function run() { ext(); }',
      });
      expect(has('main.ts:run', 'types.ts:ext')).toBe(true);
    });

    it('resolves overloaded globals to one target', () => {
      const { has } = analyze({
        'lib.ts':
          'function f(a: string): void;\nfunction f(a: number): void;\nfunction f(a: any) {}',
        'main.ts': 'export function run() { f(1); }',
      });
      expect(has('main.ts:run', 'lib.ts:f')).toBe(true);
    });

    it('resolves through a global-root alias', () => {
      const { has } = analyze({
        'lib.js': 'export {};\nconst root = globalThis;\nroot.Shared = function () {};',
        'main.js': 'export function run() { Shared(); }',
      });
      expect(has('main.js:run', 'lib.js:Shared')).toBe(true);
    });
  });

  describe('false-positive guards', () => {
    it('does not link locals, parameters, or module-scope names to a same-named global', () => {
      const { references } = analyze({
        'lib.ts': 'function boot() {}',
        'local.ts': 'export function a() { const boot = () => {}; boot(); }',
        'param.ts': 'export function b(boot: () => void) { boot(); }',
        'module.ts': 'function boot2() {}\nexport function c() { boot2(); }',
      });
      expect(references.filter((r) => r.to === 'lib.ts:boot')).toEqual([]);
    });

    it('does not link a shadowed global root or a local namespace-like object', () => {
      const { references } = analyze({
        'lib.js': 'globalThis.App.Engine = {};\nwindow.handler = function () {};',
        'shadow.js': [
          'export function a() { const App = { Engine: 1 }; return App.Engine; }',
          'export function b(self) { return self.handler; }',
        ].join('\n'),
      });
      expect(references).toEqual([]);
    });

    it('emits no edge for duplicate global names', () => {
      const { references } = analyze({
        'one.ts': 'function init() {}',
        'two.ts': 'function init() {}',
        'main.ts': 'export function run() { init(); }',
      });
      // No edge to either candidate; the only link is to the unresolved observation.
      expect(
        references.filter((r) => r.from === 'main.ts:run' && !r.to.startsWith('unresolved:')),
      ).toEqual([]);
    });

    it('does not create references for a global declared in the same file', () => {
      const { references } = analyze({
        'lib.ts': 'function boot() {}\nfunction go() { boot(); }',
      });
      expect(references).toEqual([]);
    });

    it('does not treat a declaration in a CommonJS file as a global', () => {
      const { references } = analyze({
        'a.js': 'function helper() {}\nmodule.exports = { helper };',
        'b.js': 'export function run() { helper(); }',
      });
      expect(references).toEqual([]);
    });
  });
});
