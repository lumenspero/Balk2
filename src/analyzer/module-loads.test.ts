import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRepositoryFixture, type RepositoryFixture } from '../testing/repository-fixture.js';
import { collectModuleLoads, type ModuleLoad } from './module-loads.js';
import type { LoaderProtocol } from './loader-protocols.js';

const lines = (...rows: string[]): string => rows.join('\n');

const OPTIONS = { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler' };

const FILES: Record<string, string> = {
  'util.ts': 'export const help = 1;',
  'worker.ts': 'export {};',
  'main.ts': lines(
    "const SPEC = './util.js';",
    "export const a = () => import('./util.js');",
    'export const b = () => import(SPEC);',
    'export const c = (name: string) => import(`./${name}.js`);',
    "export const d = () => import('left-pad');",
    "export const e = () => import('./missing.js');",
    "export const f = () => new Worker(new URL('./worker.js', import.meta.url));",
    "export const g = () => new URL('./util.js', import.meta.url);",
    "export const h = () => new URL('./util.js', 'https://example.com');",
    "export const i = () => require('./util.js');",
  ),
};

describe('collectModuleLoads', () => {
  let fixture: RepositoryFixture | undefined;
  let loads: ModuleLoad[] = [];

  beforeAll(() => {
    fixture = createRepositoryFixture(FILES, OPTIONS);
    loads = collectModuleLoads(fixture.repository);
  });
  afterAll(() => fixture?.cleanup());

  const find = (text: string): ModuleLoad | undefined =>
    loads.find((load) => load.subject.includes(text));

  it('reports one load per dynamic import, worker or URL, and nothing for require or foreign URLs', () => {
    expect(loads).toHaveLength(7);
    expect(find("'https://example.com'")).toBeUndefined();
    expect(find("require('./util.js')")).toBeUndefined();
  });

  it('resolves a literal import() to the repository file it names', () => {
    expect(find("import('./util.js')")).toMatchObject({
      status: 'internal',
      loadKind: 'import-expression',
      target: 'util.ts',
      specifier: './util.js',
    });
  });

  it('resolves a specifier bound by a const declaration', () => {
    expect(find('import(SPEC)')).toMatchObject({
      status: 'internal',
      target: 'util.ts',
    });
  });

  it('reports a computed specifier as dynamic, with no target', () => {
    expect(find('import(`./${name}.js`)')).toMatchObject({ status: 'dynamic' });
  });

  it('reports a bare package specifier as external', () => {
    expect(find("import('left-pad')")).toMatchObject({
      status: 'external',
      specifier: 'left-pad',
    });
  });

  it('reports a relative specifier that names no file as unresolved', () => {
    expect(find("import('./missing.js')")).toMatchObject({ status: 'unresolved' });
  });

  it('classifies a URL inside new Worker as a worker load', () => {
    expect(find("new URL('./worker.js'")).toMatchObject({
      status: 'internal',
      loadKind: 'worker',
      target: 'worker.ts',
    });
  });

  it('classifies a URL outside a worker as a url load', () => {
    expect(find("new URL('./util.js'")).toMatchObject({
      status: 'internal',
      loadKind: 'url',
      target: 'util.ts',
    });
  });
});

describe('collectModuleLoads: loader receiver rules', () => {
  // A loader whose receiver is a string ('any' or 'event-like') is not a valid loader rule.
  // It must never match, or one malformed entry would widen to every method call of that name.
  const stringReceiver = {
    function: 'load',
    specifierArg: 0,
    receiver: 'any',
  } as unknown as LoaderProtocol;

  const repo = (): RepositoryFixture =>
    createRepositoryFixture(
      {
        'util.ts': 'export const u = 1;',
        'main.ts': lines(
          'declare const anything: { load(specifier: string): unknown };',
          "export const viaAny = () => anything.load('./util.js');",
        ),
      },
      OPTIONS,
    );

  it('does not match a method call when the receiver rule is a string', () => {
    const fixture = repo();
    try {
      expect(collectModuleLoads(fixture.repository, [stringReceiver])).toHaveLength(0);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('collectModuleLoads on a directory URL', () => {
  it('reports nothing for a new URL whose specifier names a directory', () => {
    const fixture = createRepositoryFixture(
      {
        'locales/index.ts': 'export {};',
        'reader.ts': "export const dir = () => new URL('./locales/', import.meta.url);",
      },
      OPTIONS,
    );
    try {
      expect(collectModuleLoads(fixture.repository)).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});
