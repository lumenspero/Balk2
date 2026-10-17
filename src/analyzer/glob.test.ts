import { describe, expect, it } from 'vitest';
import { compileGlob } from './glob.js';

describe('compileGlob', () => {
  it('matches one segment with *, and not across a slash', () => {
    const glob = compileGlob('src/commands/*.ts');
    expect(glob.test('src/commands/ping.ts')).toBe(true);
    expect(glob.test('src/commands/nested/ping.ts')).toBe(false);
  });

  it('matches across segments with **', () => {
    const glob = compileGlob('src/**/*.ts');
    expect(glob.test('src/a.ts')).toBe(true);
    expect(glob.test('src/deep/er/a.ts')).toBe(true);
    expect(glob.test('lib/a.ts')).toBe(false);
  });

  it('matches one character with ?, and treats dots literally', () => {
    const glob = compileGlob('cmd?.ts');
    expect(glob.test('cmd1.ts')).toBe(true);
    expect(glob.test('cmd12.ts')).toBe(false);
    expect(compileGlob('a.ts').test('aXts')).toBe(false);
  });

  it('never lets ? match a slash, so it stays within one segment', () => {
    const glob = compileGlob('src/?.ts');
    expect(glob.test('src/a.ts')).toBe(true);
    expect(glob.test('src/a/.ts')).toBe(false);
    expect(glob.test('src//.ts')).toBe(false);
  });
});
