import { describe, expect, it } from 'vitest';
import { listValue, parseSetupCfg } from './setup-cfg.js';

describe('parseSetupCfg', () => {
  it('reads sections, = and : separators, comments and continuation lines', () => {
    const text = [
      '# a comment',
      '[metadata]',
      'name = demo',
      'version: 1.0',
      '',
      '[options.packages.find]',
      'where =',
      '    src',
      '    lib',
      '; another comment',
    ].join('\n');
    const { sections, errors } = parseSetupCfg(text);
    expect(errors).toEqual([]);
    expect(sections.get('metadata')?.get('name')).toBe('demo');
    expect(sections.get('metadata')?.get('version')).toBe('1.0');
    expect(listValue(sections.get('options.packages.find')?.get('where'))).toEqual(['src', 'lib']);
  });

  it('accepts CRLF line endings and lower-cases section and key names', () => {
    const { sections, errors } = parseSetupCfg('[Metadata]\r\nName = demo\r\n');
    expect(errors).toEqual([]);
    expect(sections.get('metadata')?.get('name')).toBe('demo');
  });

  it('reports bad lines as errors and never throws', () => {
    const { errors } = parseSetupCfg('name = outside\n[ok]\nnot a pair\n   stray');
    expect(errors.map((error) => error.line)).toEqual([1, 3, 4]);
  });
});

describe('listValue', () => {
  it('splits on commas and newlines and drops empty entries', () => {
    expect(listValue('a, b\n\n c ')).toEqual(['a', 'b', 'c']);
    expect(listValue(undefined)).toEqual([]);
  });
});
