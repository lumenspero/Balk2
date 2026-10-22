import { describe, expect, it } from 'vitest';
import { parseCargoManifest } from './manifest.js';
import { globToRegExp, workspaceMemberDirs } from './workspace-members.js';

describe('globToRegExp', () => {
  it('matches * within one segment only', () => {
    const pattern = globToRegExp('crates/*');
    expect(pattern.test('crates/core')).toBe(true);
    expect(pattern.test('crates/core/inner')).toBe(false);
    expect(pattern.test('crates')).toBe(false);
  });

  it('matches ** across segments and ? within one', () => {
    expect(globToRegExp('libs/**').test('libs/a/b')).toBe(true);
    expect(globToRegExp('pkg-?').test('pkg-a')).toBe(true);
    expect(globToRegExp('pkg-?').test('pkg-ab')).toBe(false);
  });

  it('treats other characters literally', () => {
    expect(globToRegExp('a.b+c').test('a.b+c')).toBe(true);
    expect(globToRegExp('a.b+c').test('aXb+c')).toBe(false);
  });
});

describe('workspaceMemberDirs', () => {
  const workspace = parseCargoManifest(
    'Cargo.toml',
    '[workspace]\nmembers = ["crates/*", "tools/cli"]\nexclude = ["crates/old"]\n',
  ).workspace;
  const candidates = ['.', 'crates/core', 'crates/old', 'crates/app/inner', 'tools/cli', 'other'];

  it('expands member globs over the directories that contain a manifest', () => {
    const members = workspaceMemberDirs('.', workspace!, candidates, false);
    expect([...members].sort()).toEqual(['crates/core', 'tools/cli']);
  });

  it('applies exclude after members', () => {
    const members = workspaceMemberDirs('.', workspace!, ['crates/old'], false);
    expect(members.size).toBe(0);
  });

  it('resolves patterns against a nested workspace root', () => {
    const nested = parseCargoManifest(
      'tools/Cargo.toml',
      '[workspace]\nmembers = ["cli/*"]\n',
    ).workspace;
    const members = workspaceMemberDirs(
      'tools',
      nested!,
      ['tools/cli/a', 'tools/cli/a/b', 'cli/a'],
      false,
    );
    expect([...members]).toEqual(['tools/cli/a']);
  });

  it('includes the root itself when it is a package', () => {
    const members = workspaceMemberDirs('.', workspace!, [], true);
    expect([...members]).toEqual(['.']);
  });
});
