import { describe, expect, it } from 'vitest';
import { readSetupPy } from './setup-py.js';

describe('readSetupPy', () => {
  it('reads literal name, package_dir root and packages list', () => {
    const facts = readSetupPy(
      'svc',
      [
        'from setuptools import setup',
        'setup(',
        '    name="legacy-svc",',
        '    package_dir={"": "src"},',
        '    packages=["svc"],',
        ')',
      ].join('\n'),
    );
    expect(facts.name).toBe('legacy-svc');
    expect(facts.roots).toEqual(['svc/src']);
    expect(facts.notes).toEqual([]);
  });

  it('gives the repository root for a packages list with no mapping', () => {
    const facts = readSetupPy(
      '.',
      'from setuptools import setup\nsetup(name="flat", packages=["flat"])',
    );
    expect(facts.roots).toEqual(['.']);
  });

  it('reads find_packages where, and the root when there is no where', () => {
    const withWhere = readSetupPy(
      '.',
      'import setuptools\nsetuptools.setup(name="a", packages=find_packages(where="lib"))',
    );
    expect(withWhere.roots).toEqual(['lib']);
    const bare = readSetupPy('.', 'setup(name="a", packages=find_packages())');
    expect(bare.roots).toEqual(['.']);
  });

  it('finds the call inside a top-level main block', () => {
    const facts = readSetupPy(
      '.',
      ['if __name__ == "__main__":', '    setup(name="guarded", package_dir={"": "src"})', ''].join(
        '\n',
      ),
    );
    expect(facts.name).toBe('guarded');
    expect(facts.roots).toEqual(['src']);
  });

  it('does not read computed values', () => {
    const facts = readSetupPy('.', 'setup(name=NAME, packages=discover())');
    expect(facts.name).toBeUndefined();
    expect(facts.roots).toEqual([]);
  });

  it('returns syntax notes and never throws', () => {
    const facts = readSetupPy('.', 'setup(name="x"\nthis is not python ::\n');
    expect(facts.notes.length).toBeGreaterThan(0);
  });
});
