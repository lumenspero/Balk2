import { describe, expect, it } from 'vitest';
import {
  runResourceEngine,
  type ResourceCatalogEntry,
  type ResourceEdge,
} from './resource-engine.js';
import type { CallSite, FileFacts, ModuleEdge } from './types.js';

const span = {
  filePath: 'src/app/main.ts',
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: 2,
};
const catalog: ResourceCatalogEntry[] = [
  { function: 'loadTemplate', specifierArg: 0, languages: ['typescript', 'javascript'] },
];
const existing = new Set([
  'src/app/style.css',
  'src/app/page.html',
  'src/ui/tpl/card.html',
  'tpl/root.html',
]);
const fileExists = (repoPath: string): boolean => existing.has(repoPath);

function importFact(filePath: string, specifier: string): ModuleEdge {
  return {
    kind: 'module-edge',
    filePath,
    span: { ...span, filePath },
    owner: null,
    form: 'import',
    specifier,
    target: { kind: 'unresolved', reason: 'unresolved-module-path', subject: specifier },
    names: [],
    typeOnly: false,
  };
}

function loaderCall(
  filePath: string,
  name: string,
  positional: CallSite['positional'],
  methodName?: string,
): CallSite {
  return {
    kind: 'call',
    filePath,
    span: { ...span, filePath },
    owner: `${filePath}:render`,
    name,
    ...(methodName !== undefined ? { methodName } : {}),
    text: `${name}(...)`,
    positional,
    keyword: {},
  };
}

function run(
  facts: FileFacts['facts'],
  language: FileFacts['language'] = 'typescript',
): ResourceEdge[] {
  return runResourceEngine({
    files: [{ filePath: facts[0]?.filePath ?? 'a.ts', language, facts }],
    catalog,
    fileExists,
  });
}

describe('runResourceEngine: imports', () => {
  it('links a relative import of an existing stylesheet', () => {
    const edges = run([importFact('src/app/main.ts', './style.css')]);
    expect(edges).toEqual([
      expect.objectContaining({
        kind: 'uses',
        from: 'src/app/main.ts',
        resourcePath: 'src/app/style.css',
        resourceKind: 'stylesheet',
        mechanism: 'import',
        confidence: 'high',
        evidence: 'ast',
      }),
    ]);
  });

  it('strips a query suffix such as ?raw', () => {
    const edges = run([importFact('src/app/main.ts', './page.html?raw')]);
    expect(edges[0]).toMatchObject({ resourcePath: 'src/app/page.html', resourceKind: 'template' });
  });

  it('ignores bare specifiers, paths outside the repository, and missing files', () => {
    expect(run([importFact('src/app/main.ts', 'react')])).toEqual([]);
    expect(run([importFact('src/app/main.ts', '../../../x.css')])).toEqual([]);
    expect(run([importFact('src/app/main.ts', './missing.css')])).toEqual([]);
  });
});

describe('runResourceEngine: loader calls', () => {
  it('resolves a relative loader path from the calling file', () => {
    const edges = run([
      loaderCall('src/ui/a.ts', 'loadTemplate', [{ kind: 'string', value: './tpl/card.html' }]),
    ]);
    expect(edges).toEqual([
      expect.objectContaining({
        kind: 'uses',
        from: 'src/ui/a.ts:render',
        resourcePath: 'src/ui/tpl/card.html',
        mechanism: 'loader',
        evidence: 'config',
      }),
    ]);
  });

  it('resolves a loader path without a leading dot from the repository root', () => {
    const edges = run([
      loaderCall('src/ui/a.ts', 'loadTemplate', [{ kind: 'string', value: 'tpl/root.html' }]),
    ]);
    expect(edges[0]).toMatchObject({ resourcePath: 'tpl/root.html' });
  });

  it('reports a dynamic path as an observation and ignores a non-name argument', () => {
    const dynamic = run([
      loaderCall('src/ui/a.ts', 'loadTemplate', [{ kind: 'dynamic', reason: 'computed name' }]),
    ]);
    expect(dynamic).toEqual([
      expect.objectContaining({
        kind: 'observation',
        from: 'src/ui/a.ts:render',
        detail: 'computed name',
        subject: 'loadTemplate(...)',
      }),
    ]);
    expect(run([loaderCall('src/ui/a.ts', 'loadTemplate', [{ kind: 'not-a-name' }])])).toEqual([]);
  });

  it('matches a configured name on a method call and skips other names', () => {
    const method = run([
      loaderCall(
        'src/ui/a.ts',
        'loadTemplate',
        [{ kind: 'string', value: './tpl/card.html' }],
        'loadTemplate',
      ),
    ]);
    expect(method).toHaveLength(1);
    expect(
      run([loaderCall('src/ui/a.ts', 'other', [{ kind: 'string', value: './tpl/card.html' }])]),
    ).toEqual([]);
  });

  it('ignores a file type that is not a resource', () => {
    expect(
      run([loaderCall('src/ui/a.ts', 'loadTemplate', [{ kind: 'string', value: './x.js' }])]),
    ).toEqual([]);
  });
});
