import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import type { DataLineageEntry } from './balk2-config.js';
import { applyExplicitLineage } from './lineage-processor.js';

function problemPathsOf(
  rules: readonly DataLineageEntry[],
  files: readonly string[] | undefined,
): string[] {
  const repositoryFiles = files === undefined ? undefined : new Set(files);
  return applyExplicitLineage(rules, new ConnectionGraph(), repositoryFiles).map((p) => p.path);
}

describe('lineage diagnostics', () => {
  it('reports a producer script that is not in the repository', () => {
    const paths = problemPathsOf([{ producer: 'scripts/missing.py', output: 'data/a.json' }], [
      'data/a.json',
    ]);
    expect(paths).toEqual(['data.lineage[0].producer']);
  });

  it('reports a consumer script that is not in the repository', () => {
    const paths = problemPathsOf([{ consumer: 'src/gone.ts', input: 'data/a.json' }], [
      'data/a.json',
    ]);
    expect(paths).toEqual(['data.lineage[0].consumer']);
  });

  it('does not report a missing output, because a pipeline may create it later', () => {
    const paths = problemPathsOf([{ producer: 'scripts/make.py', output: 'data/new.json' }], [
      'scripts/make.py',
    ]);
    expect(paths).toEqual([]);
  });

  it('reports an input that no file and no lineage entry provides', () => {
    const paths = problemPathsOf([{ consumer: 'src/load.ts', input: 'data/gone.parquet' }], [
      'src/load.ts',
    ]);
    expect(paths).toEqual(['data.lineage[0].input']);
  });

  it('accepts an input that another entry produces', () => {
    const paths = problemPathsOf(
      [
        { producer: 'scripts/make.py', output: 'data/raw.json' },
        { consumer: 'src/load.ts', input: 'data/raw.json' },
      ],
      ['scripts/make.py', 'src/load.ts'],
    );
    expect(paths).toEqual([]);
  });

  it('checks nothing when no file list is given', () => {
    const paths = problemPathsOf(
      [{ producer: 'scripts/missing.py', output: 'data/a.json' }],
      undefined,
    );
    expect(paths).toEqual([]);
  });
});
