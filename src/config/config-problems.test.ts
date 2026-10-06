import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadBalk2Config,
  loadBalk2ConfigDetailed,
  validateGlobalsConfig,
  type LoadedBalk2Config,
} from './balk2-config.js';

describe('loadBalk2ConfigDetailed', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-config-problems-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const write = (content: string): void => {
    fs.writeFileSync(path.join(rootDir, '.balk2.json'), content, 'utf8');
  };

  const load = (config: unknown): LoadedBalk2Config => {
    write(JSON.stringify(config));
    return loadBalk2ConfigDetailed(rootDir);
  };

  it('reports no problems and no config when there is no file', () => {
    expect(loadBalk2ConfigDetailed(rootDir)).toEqual({ problems: [] });
    expect(loadBalk2Config(rootDir)).toBeUndefined();
  });

  it('loads a valid protocols section alongside the other settings', () => {
    const methods = [{ method: 'publish', direction: 'emit', eventArg: 0, payloadArg: 1 }];
    const loaded = load({ include: ['src'], protocols: { events: { methods } } });

    expect(loaded.problems).toEqual([]);
    expect(loaded.config).toMatchObject({ include: ['src'] });
    expect(loaded.config?.protocols).toEqual({ events: { methods } });
  });

  it('keeps usable parts of a partly invalid configuration and reports the rest', () => {
    const loaded = load({
      globals: { roots: ['window', 'not valid'], bogus: true },
      protocols: { events: { methods: [{ method: 'x' }] }, registries: {} },
    });

    expect(loaded.config?.globals).toEqual({ roots: ['window'] });
    expect(loaded.config).not.toHaveProperty('protocols');
    expect(loaded.problems.map((p) => p.path)).toEqual([
      'globals.bogus',
      'globals.roots[1]',
      'protocols.events.methods[0].direction',
      'protocols.registries',
    ]);
  });

  it('reports unparsable and non-object files', () => {
    write('{ not json');
    const broken = loadBalk2ConfigDetailed(rootDir);
    expect(broken.config).toBeUndefined();
    expect(broken.problems).toHaveLength(1);
    expect(broken.problems[0]?.message).toContain('could not read or parse configuration');

    expect(load(['a']).problems).toEqual([
      { path: '', message: 'configuration must be a JSON object' },
    ]);
    expect(loadBalk2Config(rootDir)).toBeUndefined();
  });

  it('keeps loadBalk2Config behavior: the same config, without the problems', () => {
    write(JSON.stringify({ output: 'out', protocols: { events: { builtIns: false } } }));

    expect(loadBalk2Config(rootDir)).toEqual({
      output: 'out',
      protocols: { events: { builtIns: false } },
    });
  });
});

describe('validateGlobalsConfig', () => {
  const messages = (value: unknown): string[] =>
    validateGlobalsConfig(value).map((problem) => `${problem.path}: ${problem.message}`);

  it('accepts a valid section', () => {
    expect(messages({ roots: ['window'], targets: { init: 'src/a.js' } })).toEqual([]);
  });

  it('rejects non-objects and unknown keys', () => {
    expect(messages('x')).toEqual(['globals: must be an object']);
    expect(messages({ extra: 1 })).toEqual(['globals.extra: unknown key ignored']);
  });

  it('reports invalid roots, and the fallback when none are valid', () => {
    expect(messages({ roots: 'window' })).toEqual([
      'globals.roots: must be an array of identifiers',
    ]);
    expect(messages({ roots: ['ok', 'no good'] })).toEqual([
      'globals.roots[1]: must be an identifier',
    ]);
    expect(messages({ roots: ['no good', 3] })).toEqual([
      'globals.roots[0]: must be an identifier',
      'globals.roots[1]: must be an identifier',
      'globals.roots: has no valid identifiers; the default roots are kept',
    ]);
    expect(messages({ roots: [] })).toEqual([]);
  });

  it('reports invalid targets', () => {
    expect(messages({ targets: [] })).toEqual([
      'globals.targets: must be an object of name to file path',
    ]);
    expect(messages({ targets: { init: 3, '': 'a.js', ok: 'b.js', blank: '' } })).toEqual([
      'globals.targets.init: must be a non-empty file path',
      'globals.targets: a target name must not be empty',
      'globals.targets.blank: must be a non-empty file path',
    ]);
  });
});
