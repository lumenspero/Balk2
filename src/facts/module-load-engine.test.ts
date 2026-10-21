import { describe, expect, it } from 'vitest';
import { DYNAMIC_SPECIFIER_DETAIL, runModuleLoadEngine } from './module-load-engine.js';
import type { FileFacts, ModuleEdge } from './types.js';

const span = { filePath: 'src/main.ts', startLine: 2, startColumn: 1, endLine: 2, endColumn: 20 };

function load(target: ModuleEdge['target'], overrides: Partial<ModuleEdge> = {}): ModuleEdge {
  return {
    kind: 'module-edge',
    filePath: 'src/main.ts',
    span,
    owner: 'src/main.ts:run',
    form: 'load',
    specifier: './util.js',
    target,
    names: [],
    typeOnly: false,
    loadKind: 'import-expression',
    ...overrides,
  };
}

function file(facts: ModuleEdge[]): FileFacts {
  return { filePath: 'src/main.ts', language: 'typescript', facts };
}

describe('runModuleLoadEngine', () => {
  it('adds an imports edge from the owner to a repository file', () => {
    expect(runModuleLoadEngine([file([load({ kind: 'file', path: 'src/util.ts' })])])).toEqual([
      {
        kind: 'imports',
        from: 'src/main.ts:run',
        to: 'src/util.ts',
        loadKind: 'import-expression',
        span,
      },
    ]);
  });

  it('reports a dynamic specifier as an observation with the subject and detail', () => {
    const edges = runModuleLoadEngine([
      file([
        load(
          { kind: 'unresolved', reason: 'dynamic-module-specifier', subject: 'import(name)' },
          { loadKind: 'worker', owner: undefined },
        ),
      ]),
    ]);
    expect(edges).toEqual([
      {
        kind: 'observation',
        from: 'src/main.ts',
        subject: 'import(name)',
        detail: DYNAMIC_SPECIFIER_DETAIL,
        loadKind: 'worker',
        span,
      },
    ]);
  });

  it('adds nothing for external and unresolved loads', () => {
    expect(
      runModuleLoadEngine([
        file([
          load({ kind: 'external', name: 'left-pad' }),
          load({ kind: 'unresolved', reason: 'unresolved-module-path', subject: './missing.js' }),
        ]),
      ]),
    ).toEqual([]);
  });

  it('ignores edges that are not loads', () => {
    expect(
      runModuleLoadEngine([
        file([
          load({ kind: 'file', path: 'src/util.ts' }, { form: 'import', loadKind: undefined }),
        ]),
      ]),
    ).toEqual([]);
  });
});
