import { describe, expect, it } from 'vitest';
import { globToRegExp } from './glob.js';

describe('globToRegExp', () => {
  it('keeps * and ? inside one path segment', () => {
    expect(globToRegExp('packages/*').test('packages/app')).toBe(true);
    expect(globToRegExp('packages/*').test('packages/app/src')).toBe(false);
    expect(globToRegExp('pkg?').test('pkg1')).toBe(true);
    expect(globToRegExp('pkg?').test('pkg12')).toBe(false);
  });

  it('lets ** span segments, including none before a slash', () => {
    expect(globToRegExp('crates/**').test('crates/a/b')).toBe(true);
    expect(globToRegExp('**/x.js').test('x.js')).toBe(true);
    expect(globToRegExp('**/x.js').test('a/b/x.js')).toBe(true);
  });

  it('matches dots and other characters literally', () => {
    expect(globToRegExp('a.js').test('a.js')).toBe(true);
    expect(globToRegExp('a.js').test('aXjs')).toBe(false);
  });
});
