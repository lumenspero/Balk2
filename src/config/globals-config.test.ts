import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBalk2Config, normalizeGlobalsConfig, type Balk2Config } from './balk2-config.js';

describe('globals configuration', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-globals-config-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const load = (config: unknown): Balk2Config | undefined => {
    fs.writeFileSync(path.join(rootDir, '.balk2.json'), JSON.stringify(config), 'utf8');
    return loadBalk2Config(rootDir);
  };

  it('loads roots and targets from .balk2.json', () => {
    expect(
      load({ globals: { roots: ['globalThis', 'window'], targets: { init: 'src/a.js' } } })
        ?.globals,
    ).toEqual({ roots: ['globalThis', 'window'], targets: { init: 'src/a.js' } });
  });

  it('leaves other configuration untouched', () => {
    const config = load({ include: ['src'], output: 'out', globals: { roots: ['globalThis'] } });
    expect(config).toMatchObject({ include: ['src'], output: 'out' });
  });

  it('omits globals when absent or malformed', () => {
    expect(load({ include: ['src'] })).not.toHaveProperty('globals');
    expect(load({ globals: 'nope' })).not.toHaveProperty('globals');
    expect(load({ globals: [] })).not.toHaveProperty('globals');
  });

  describe('normalizeGlobalsConfig', () => {
    it('drops invalid root names and dedupes', () => {
      expect(normalizeGlobalsConfig({ roots: ['window', 'window', 'not valid', 3] })).toEqual({
        roots: ['window'],
      });
    });

    it('ignores a roots list with no valid entries so defaults are not silently disabled', () => {
      expect(normalizeGlobalsConfig({ roots: ['not valid', 42] })).toBeUndefined();
    });

    it('allows an explicitly empty roots list', () => {
      expect(normalizeGlobalsConfig({ roots: [] })).toEqual({ roots: [] });
    });

    it('keeps only string-to-string targets', () => {
      expect(
        normalizeGlobalsConfig({ targets: { init: 'a.js', bad: 1, '': 'x.js', empty: '' } }),
      ).toEqual({ targets: { init: 'a.js' } });
    });

    it('returns undefined for non-objects', () => {
      expect(normalizeGlobalsConfig(undefined)).toBeUndefined();
      expect(normalizeGlobalsConfig(null)).toBeUndefined();
      expect(normalizeGlobalsConfig(['a'])).toBeUndefined();
    });
  });
});
