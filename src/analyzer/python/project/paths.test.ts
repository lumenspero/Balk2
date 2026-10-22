import { describe, expect, it } from 'vitest';
import { dirOf, joinRepoPath } from './paths.js';

describe('joinRepoPath', () => {
  it('resolves relative segments against the manifest directory', () => {
    expect(joinRepoPath('services/api', 'src')).toBe('services/api/src');
    expect(joinRepoPath('.', './src')).toBe('src');
    expect(joinRepoPath('.', '.')).toBe('.');
    expect(joinRepoPath('a/b', '../c')).toBe('a/c');
    expect(joinRepoPath('a', '.')).toBe('a');
  });
});

describe('dirOf', () => {
  it('gives the containing directory, or . for a root-level file', () => {
    expect(dirOf('pyproject.toml')).toBe('.');
    expect(dirOf('services/api/setup.cfg')).toBe('services/api');
    expect(dirOf('services\\api\\setup.cfg')).toBe('services/api');
  });
});
