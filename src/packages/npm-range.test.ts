import { describe, expect, it } from 'vitest';
import { satisfiesRange } from './npm-range.js';

describe('satisfiesRange', () => {
  it('accepts any version for the wildcard forms', () => {
    for (const range of ['*', 'x', '']) expect(satisfiesRange('3.1.4', range)).toBe(true);
  });

  it('matches exact versions, with or without = or v', () => {
    expect(satisfiesRange('1.2.3', '1.2.3')).toBe(true);
    expect(satisfiesRange('1.2.3', '=1.2.3')).toBe(true);
    expect(satisfiesRange('1.2.3', 'v1.2.3')).toBe(true);
    expect(satisfiesRange('1.2.4', '1.2.3')).toBe(false);
  });

  it('applies caret ranges, fixing the leftmost non-zero component', () => {
    expect(satisfiesRange('1.9.0', '^1.2.3')).toBe(true);
    expect(satisfiesRange('2.0.0', '^1.2.3')).toBe(false);
    expect(satisfiesRange('0.2.9', '^0.2.3')).toBe(true);
    expect(satisfiesRange('0.3.0', '^0.2.3')).toBe(false);
    expect(satisfiesRange('0.0.3', '^0.0.3')).toBe(true);
    expect(satisfiesRange('0.0.4', '^0.0.3')).toBe(false);
    expect(satisfiesRange('1.5.0', '^1')).toBe(true);
    expect(satisfiesRange('0.9.0', '^0')).toBe(true);
    expect(satisfiesRange('1.0.0', '^0')).toBe(false);
  });

  it('applies tilde ranges, fixing the minor component', () => {
    expect(satisfiesRange('1.2.9', '~1.2.3')).toBe(true);
    expect(satisfiesRange('1.3.0', '~1.2.3')).toBe(false);
    expect(satisfiesRange('1.9.0', '~1')).toBe(true);
    expect(satisfiesRange('2.0.0', '~1')).toBe(false);
  });

  it('applies x-ranges and partial versions', () => {
    expect(satisfiesRange('1.5.0', '1')).toBe(true);
    expect(satisfiesRange('2.0.0', '1.x')).toBe(false);
    expect(satisfiesRange('1.2.9', '1.2.x')).toBe(true);
    expect(satisfiesRange('1.3.0', '1.2.x')).toBe(false);
    expect(satisfiesRange('1.0.0', '1.2')).toBe(false);
  });

  it('returns undefined for syntax it does not understand, and for prerelease versions', () => {
    for (const range of ['>=1.0.0', '1.0.0 - 2.0.0', '^1.0.0 || ^2.0.0', '1.2.3-beta', '1.x.3']) {
      expect(satisfiesRange('1.2.3', range)).toBeUndefined();
    }
    expect(satisfiesRange('1.0.0-beta', '^1.0.0')).toBeUndefined();
    expect(satisfiesRange('1.2', '1.2.3')).toBeUndefined();
  });
});
