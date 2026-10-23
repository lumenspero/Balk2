import { describe, expect, it } from 'vitest';
import { defaultBareBases } from '../facts/path-value.js';
import {
  normalizePathBaseConfig,
  pathBaseOrder,
  validatePathBaseConfig,
} from './path-base-config.js';

describe('data.pathBase configuration (Phase 11.4)', () => {
  it('reports unknown bases, and a list with no usable base', () => {
    expect(validatePathBaseConfig(['repository'])).toEqual([]);
    expect(validatePathBaseConfig(['nope', 'file'])).toEqual([
      { path: 'data.pathBase', message: 'unknown base ignored' },
    ]);
    expect(validatePathBaseConfig(['nope'])).toEqual([
      { path: 'data.pathBase', message: 'unknown base ignored' },
      { path: 'data.pathBase', message: 'lists no usable base' },
    ]);
  });

  it('reports an unknown language in the per-language form', () => {
    expect(validatePathBaseConfig({ cobol: ['file'] })).toEqual([
      { path: 'data.pathBase.cobol', message: 'unknown language ignored' },
    ]);
  });

  it('keeps only the usable bases, and drops a value with none', () => {
    expect(normalizePathBaseConfig(['nope', 'file'])).toEqual(['file']);
    expect(normalizePathBaseConfig(['nope'])).toBeUndefined();
    expect(normalizePathBaseConfig({ python: ['repository'], rust: ['nope'] })).toEqual({
      python: ['repository'],
    });
  });

  it('gives a list for every language, and an object for the languages it names', () => {
    expect(pathBaseOrder({ data: { pathBase: ['file'] } }, 'rust')).toEqual(['file']);
    const perLanguage = { data: { pathBase: { python: ['repository'] } } };
    expect(pathBaseOrder(perLanguage, 'python')).toEqual(['repository']);
    expect(pathBaseOrder(perLanguage, 'rust')).toBeUndefined();
    expect(pathBaseOrder(undefined, 'python')).toBeUndefined();
  });
});

describe('defaultBareBases with an override (Phase 11.4)', () => {
  it('uses the override, with the repository root last', () => {
    expect(defaultBareBases('python', { file: 'lib' }, ['repository']).order).toEqual([
      'repository',
    ]);
    expect(defaultBareBases('python', { file: 'lib' }, ['repository', 'file']).order).toEqual([
      'file',
      'repository',
    ]);
  });

  it('keeps the default order when there is no override', () => {
    expect(defaultBareBases('rust', { file: 'src', package: '' }).order).toEqual([
      'package',
      'repository',
    ]);
  });
});
