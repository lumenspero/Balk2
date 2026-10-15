import { describe, expect, it } from 'vitest';
import type { ConfigProblem } from './config-problem.js';
import { normalizeRegistries } from './registry-protocols-config.js';

function check(value: unknown): {
  result: ReturnType<typeof normalizeRegistries>;
  problems: ConfigProblem[];
} {
  const problems: ConfigProblem[] = [];
  const result = normalizeRegistries(value, problems);
  return { result, problems };
}

describe('registry sources in protocols.registries', () => {
  it('accepts decorators, manifest entries and discovery rules', () => {
    const { result, problems } = check({
      decorators: [{ name: 'register', registry: 'src/container.ts:container', keyArg: 0 }],
      manifest: [{ registry: 'src/container.ts:container', key: 'gen', target: 'src/gen.ts:Gen' }],
      discover: [{ glob: 'src/commands/*.ts', registry: 'src/cli.ts:commands' }],
    });
    expect(problems).toEqual([]);
    expect(result?.decorators).toEqual([
      { name: 'register', registry: 'src/container.ts:container', keyArg: 0 },
    ]);
    expect(result?.manifest).toHaveLength(1);
    expect(result?.discover).toEqual([
      { glob: 'src/commands/*.ts', registry: 'src/cli.ts:commands' },
    ]);
  });

  it('drops a decorator whose name is not an identifier, and reports it', () => {
    const { result, problems } = check({
      decorators: [{ name: 'not valid', registry: 'src/a.ts:reg' }],
    });
    expect(result).toBeUndefined();
    expect(problems.map((p) => p.path)).toEqual(['protocols.registries.decorators[0].name']);
  });

  it('rejects an absolute discovery glob, since it would match nothing', () => {
    const { result, problems } = check({
      discover: [{ glob: '/src/*.ts', registry: 'src/cli.ts:commands' }],
    });
    expect(result).toBeUndefined();
    expect(problems[0]?.message).toContain('relative to the repository');
  });

  it('reports unknown keys inside an entry and ignores them', () => {
    const { result, problems } = check({
      manifest: [{ registry: 'a.ts:r', key: 'k', target: 'a.ts:A', extra: true }],
    });
    expect(result?.manifest).toEqual([{ registry: 'a.ts:r', key: 'k', target: 'a.ts:A' }]);
    expect(problems.map((p) => p.path)).toEqual(['protocols.registries.manifest[0].extra']);
  });

  it('reports a list that is not an array, and keeps the rest of the section', () => {
    const { result, problems } = check({
      manifest: 'nope',
      builtIns: false,
    });
    expect(result).toEqual({ builtIns: false });
    expect(problems.map((p) => p.path)).toEqual(['protocols.registries.manifest']);
  });
});
