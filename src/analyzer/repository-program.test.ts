import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { createRepositoryProgram } from './repository-program.js';

describe('RepositoryProgram', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-program-test-'));
    fs.mkdirSync(path.join(rootDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(rootDir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      'utf8',
    );
    fs.writeFileSync(path.join(rootDir, 'src', 'helper.ts'), 'export const helper = 1;', 'utf8');
    fs.writeFileSync(
      path.join(rootDir, 'src', 'barrel.ts'),
      "export { helper } from './helper.js';",
      'utf8',
    );
    fs.writeFileSync(
      path.join(rootDir, 'src', 'main.ts'),
      "import { helper } from '@/helper'; export const value = helper;",
      'utf8',
    );
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('parses repository files once and resolves internal aliases through tsconfig', () => {
    const repository = createRepositoryProgram({
      rootDir,
      filePaths: ['src/main.ts', 'src/helper.ts', 'src/barrel.ts'],
    });

    expect(repository.sourceFiles.size).toBe(3);
    expect(repository.resolveModule('src/main.ts', '@/helper')).toEqual({
      fromFile: 'src/main.ts',
      specifier: '@/helper',
      kind: 'internal',
      path: 'src/helper.ts',
      resolution: 'typescript',
    });
  });

  it('classifies external and missing modules without inventing repository paths', () => {
    const repository = createRepositoryProgram({
      rootDir,
      filePaths: ['src/main.ts', 'src/helper.ts', 'src/barrel.ts'],
    });

    expect(repository.resolveModule('src/main.ts', 'node:fs').kind).toBe('external');
    expect(repository.resolveModule('src/main.ts', './missing.js')).toEqual({
      fromFile: 'src/main.ts',
      specifier: './missing.js',
      kind: 'unresolved',
      resolution: 'unresolved',
    });
  });

  it('uses the shared resolver when building graph imports and re-exports', () => {
    const repository = createRepositoryProgram({
      rootDir,
      filePaths: ['src/main.ts', 'src/helper.ts', 'src/barrel.ts'],
    });
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(repository, graph);

    const relationships = graph.getRelationships();
    expect(
      relationships.some(
        (relationship) =>
          relationship.type === 'imports' &&
          relationship.from === 'src/main.ts' &&
          relationship.to === 'src/helper.ts',
      ),
    ).toBe(true);
    expect(
      relationships.some(
        (relationship) =>
          relationship.type === 'imports' &&
          relationship.from === 'src/barrel.ts' &&
          relationship.to === 'src/helper.ts',
      ),
    ).toBe(true);
  });
});
