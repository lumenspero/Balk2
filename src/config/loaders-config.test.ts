import { describe, expect, it } from 'vitest';
import type { ConfigProblem } from './config-problem.js';
import { normalizeLoaders } from './loaders-config.js';
import { normalizeProtocolsConfig } from './protocols-config.js';

const run = (value: unknown) => {
  const problems: ConfigProblem[] = [];
  const loaders = normalizeLoaders(value, problems);
  return { loaders, problems };
};

describe('normalizeLoaders', () => {
  it('keeps a plain function loader and a receiver-scoped one', () => {
    const { loaders, problems } = run([
      { function: 'loadPlugin', specifierArg: 0 },
      { function: 'load', specifierArg: 1, receiver: { names: ['plugins'] } },
    ]);
    expect(problems).toEqual([]);
    expect(loaders).toEqual([
      { function: 'loadPlugin', specifierArg: 0 },
      { function: 'load', specifierArg: 1, receiver: { names: ['plugins'] } },
    ]);
  });

  it('rejects an entry with no valid specifierArg, and keeps the others', () => {
    const { loaders, problems } = run([
      { function: 'loadPlugin' },
      { function: 'loadTheme', specifierArg: 0 },
    ]);
    expect(loaders).toEqual([{ function: 'loadTheme', specifierArg: 0 }]);
    expect(problems.map((p) => p.path)).toContain('protocols.loaders[0].specifierArg');
  });

  it('rejects a malformed receiver whole rather than matching every call', () => {
    const { loaders, problems } = run([{ function: 'load', specifierArg: 0, receiver: 'any' }]);
    expect(loaders).toBeUndefined();
    expect(problems.map((p) => p.path)).toContain('protocols.loaders[0].receiver');
  });

  it('does not accept "any" as a loader receiver', () => {
    const { loaders } = run([{ function: 'load', specifierArg: 0, receiver: { names: [] } }]);
    expect(loaders).toBeUndefined();
  });

  it('keeps the first of two identical loaders and reports the second', () => {
    const { loaders, problems } = run([
      { function: 'loadPlugin', specifierArg: 0 },
      { function: 'loadPlugin', specifierArg: 1 },
    ]);
    expect(loaders).toEqual([{ function: 'loadPlugin', specifierArg: 0 }]);
    expect(problems.map((p) => p.path)).toContain('protocols.loaders[1]');
  });

  it('reports a value that is not an array', () => {
    const { loaders, problems } = run({ function: 'loadPlugin' });
    expect(loaders).toBeUndefined();
    expect(problems).toEqual([{ path: 'protocols.loaders', message: 'must be an array' }]);
  });
});

describe('normalizeProtocolsConfig with loaders', () => {
  it('accepts loaders alongside the other protocol families', () => {
    const result = normalizeProtocolsConfig({
      loaders: [{ function: 'loadPlugin', specifierArg: 0 }],
    });
    expect(result.problems).toEqual([]);
    expect(result.config?.loaders).toEqual([{ function: 'loadPlugin', specifierArg: 0 }]);
  });
});