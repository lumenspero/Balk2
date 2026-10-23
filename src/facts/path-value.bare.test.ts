import { describe, expect, it } from 'vitest';
import { defaultBareBases, resolveBarePath } from './path-value.js';

const none = (): boolean => false;

describe('resolveBarePath (Phase 11.4)', () => {
  it('uses the file directory when that is the only candidate that exists', () => {
    const bases = defaultBareBases('typescript', { file: 'src/app' });
    expect(resolveBarePath('data.json', bases, (p) => p === 'src/app/data.json')).toBe(
      'src/app/data.json',
    );
  });

  it('uses the repository root when that is the only candidate that exists', () => {
    const bases = defaultBareBases('javascript', { file: 'src/app' });
    expect(resolveBarePath('data.json', bases, (p) => p === 'data.json')).toBe('data.json');
  });

  it('uses the file directory first when both candidates exist', () => {
    const bases = defaultBareBases('python', { file: 'scripts' });
    expect(resolveBarePath('data.json', bases, () => true)).toBe('scripts/data.json');
  });

  it('uses the first candidate, the file directory, when none exists', () => {
    const bases = defaultBareBases('python', { file: 'scripts' });
    expect(resolveBarePath('data.json', bases, none)).toBe('scripts/data.json');
  });

  it('checks the file directory of a root file as the root itself', () => {
    const bases = defaultBareBases('typescript', { file: '' });
    expect(resolveBarePath('data.json', bases, none)).toBe('data.json');
  });

  it('checks the package directory first for Cargo, then the root', () => {
    const bases = defaultBareBases('rust', { file: 'crates/core/src', package: 'crates/core' });
    expect(resolveBarePath('fixtures/a.json', bases, (p) => p === 'fixtures/a.json')).toBe(
      'fixtures/a.json',
    );
    expect(resolveBarePath('a.json', bases, (p) => p === 'crates/core/a.json')).toBe(
      'crates/core/a.json',
    );
  });

  it('skips a package base when the file has no package', () => {
    const bases = defaultBareBases('rust', { file: 'src' });
    expect(resolveBarePath('a.json', bases, none)).toBe('a.json');
  });

  it('gives no path for a path that climbs out of the repository or is absolute', () => {
    const bases = defaultBareBases('typescript', { file: '' });
    expect(resolveBarePath('../a.json', bases, none)).toBeUndefined();
    expect(resolveBarePath('/a.json', bases, none)).toBeUndefined();
  });
});
