import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBalk2ConfigDetailed, type LoadedBalk2Config } from './balk2-config.js';
import { normalizeStateConfig, type StateConfig } from './state-config.js';

const messages = (value: unknown): string[] =>
  normalizeStateConfig(value).problems.map((problem) => `${problem.path}: ${problem.message}`);

const configOf = (value: unknown): StateConfig | undefined => normalizeStateConfig(value).config;

describe('normalizeStateConfig', () => {
  it('accepts a complete valid section without problems', () => {
    const section = {
      roots: ['__APP_STATE__'],
      globals: ['store'],
      singletons: [{ module: 'src/store.ts', export: 'store' }],
      builtIns: true,
      disable: ['has'],
      methods: [{ method: 'select', access: 'read', keyArg: 0, pathSeparator: '.' }],
      dynamicPaths: 'wildcard',
    };
    expect(normalizeStateConfig(section)).toEqual({ config: section, problems: [] });
  });

  it('rejects non-objects and reports unknown keys', () => {
    expect(normalizeStateConfig('x')).toEqual({
      problems: [{ path: 'state', message: 'must be an object' }],
    });
    expect(messages({ extra: 1 })).toEqual(['state.extra: unknown key ignored']);
  });

  it('omits the config when nothing usable is left', () => {
    expect(configOf({})).toBeUndefined();
    expect(configOf({ roots: [] })).toBeUndefined();
  });

  describe('roots', () => {
    it('keeps distinct identifiers and reports the rest', () => {
      expect(configOf({ roots: ['a', 'a', 'not valid', 3] })).toEqual({ roots: ['a'] });
      expect(messages({ roots: ['a', 'not valid'] })).toEqual([
        'state.roots[1]: must be an identifier',
      ]);
      expect(messages({ roots: 'a' })).toEqual(['state.roots: must be an array of identifiers']);
    });
  });

  describe('globals', () => {
    it('accepts true, false and a list of names', () => {
      expect(configOf({ globals: true })).toEqual({ globals: true });
      expect(configOf({ globals: false })).toEqual({ globals: false });
      expect(configOf({ globals: ['store', 'store', 'App'] })).toEqual({
        globals: ['store', 'App'],
      });
      expect(configOf({ globals: [] })).toEqual({ globals: [] });
    });

    it('keeps the default rather than turning tracking off for an all-invalid list', () => {
      expect(configOf({ globals: ['no good'] })).toBeUndefined();
      expect(messages({ globals: ['no good'] })).toEqual([
        'state.globals[0]: must be an identifier',
        'state.globals: has no valid names; the default is kept',
      ]);
    });

    it('rejects other values', () => {
      expect(messages({ globals: 'yes' })).toEqual([
        'state.globals: must be true, false, or an array of property names',
      ]);
    });
  });

  describe('singletons', () => {
    it('normalizes module paths', () => {
      expect(configOf({ singletons: [{ module: '.\\src\\store.ts', export: 'default' }] })).toEqual(
        { singletons: [{ module: 'src/store.ts', export: 'default' }] },
      );
    });

    it('rejects unusable entries and duplicates', () => {
      const section = {
        singletons: [
          { module: 'src/a.ts', export: 'a' },
          { module: '/abs/a.ts', export: 'a' },
          { module: 'C:\\repo\\a.ts', export: 'a' },
          { module: '', export: 'a' },
          { module: 'src/a.ts', export: 'not valid' },
          { module: './src/a.ts', export: 'a' },
          'src/a.ts',
          { module: 'src/b.ts', export: 'b', extra: 1 },
        ],
      };
      expect(configOf(section)).toEqual({
        singletons: [
          { module: 'src/a.ts', export: 'a' },
          { module: 'src/b.ts', export: 'b' },
        ],
      });
      expect(messages(section)).toEqual([
        'state.singletons[1].module: must be relative to the repository; entry ignored',
        'state.singletons[2].module: must be relative to the repository; entry ignored',
        'state.singletons[3].module: must be a non-empty path; entry ignored',
        'state.singletons[4].export: must be an export name or "default"; entry ignored',
        'state.singletons[5]: duplicate singleton "src/a.ts:a" ignored; first defined at singletons[0]',
        'state.singletons[6]: must be an object; entry ignored',
        'state.singletons[7].extra: unknown key ignored',
      ]);
    });

    it('rejects a non-array', () => {
      expect(messages({ singletons: {} })).toEqual(['state.singletons: must be an array']);
    });
  });

  describe('built-ins', () => {
    it('validates builtIns and disable', () => {
      expect(configOf({ builtIns: false, disable: ['set', 'set'] })).toEqual({
        builtIns: false,
        disable: ['set'],
      });
      expect(messages({ builtIns: 'no', disable: ['set', 'select', 'no good'] })).toEqual([
        'state.builtIns: must be true or false',
        'state.disable[1]: "select" is not a built-in method; nothing to disable',
        'state.disable[2]: must be a method name',
      ]);
      expect(messages({ disable: 'set' })).toEqual([
        'state.disable: must be an array of method names',
      ]);
    });
  });

  describe('methods', () => {
    it('keeps a whole-container method without keyArg', () => {
      expect(configOf({ methods: [{ method: 'watch', access: 'read' }] })).toEqual({
        methods: [{ method: 'watch', access: 'read' }],
      });
    });

    it('rejects entries that would widen what a call touches', () => {
      const section = {
        methods: [
          { method: 'no good', access: 'read' },
          { method: 'a', access: 'modify' },
          { method: 'b', access: 'write', keyArg: -1 },
          { method: 'c', access: 'write', keyArg: '0' },
          7,
        ],
      };
      expect(configOf(section)).toBeUndefined();
      expect(messages(section)).toEqual([
        'state.methods[0].method: must be a method name; entry ignored',
        'state.methods[1].access: must be one of read, write, delete; entry ignored',
        'state.methods[2].keyArg: must be an integer from 0 to 15; entry ignored',
        'state.methods[3].keyArg: must be an integer from 0 to 15; entry ignored',
        'state.methods[4]: must be an object; entry ignored',
      ]);
    });

    it('drops only a misused pathSeparator', () => {
      const section = {
        methods: [
          { method: 'watch', access: 'read', pathSeparator: '.' },
          { method: 'pick', access: 'read', keyArg: 1, pathSeparator: '' },
        ],
      };
      expect(configOf(section)).toEqual({
        methods: [
          { method: 'watch', access: 'read' },
          { method: 'pick', access: 'read', keyArg: 1 },
        ],
      });
      expect(messages(section)).toEqual([
        'state.methods[0].pathSeparator: only applies with keyArg; field ignored',
        'state.methods[1].pathSeparator: must be a non-empty string; field ignored',
      ]);
    });

    it('ignores duplicates and unknown keys', () => {
      const section = {
        methods: [
          { method: 'select', access: 'read', keyArg: 0, receiver: 'any' },
          { method: 'select', access: 'write', keyArg: 0 },
        ],
      };
      expect(configOf(section)).toEqual({
        methods: [{ method: 'select', access: 'read', keyArg: 0 }],
      });
      expect(messages(section)).toEqual([
        'state.methods[0].receiver: unknown key ignored',
        'state.methods[1].method: duplicate method "select" ignored; first defined at methods[0]',
      ]);
    });

    it('lets a project method replace a built-in name', () => {
      expect(configOf({ methods: [{ method: 'get', access: 'read', keyArg: 1 }] })).toEqual({
        methods: [{ method: 'get', access: 'read', keyArg: 1 }],
      });
    });
  });

  describe('dynamicPaths', () => {
    it('accepts off and wildcard only', () => {
      expect(configOf({ dynamicPaths: 'off' })).toEqual({ dynamicPaths: 'off' });
      expect(configOf({ dynamicPaths: 'all' })).toBeUndefined();
      expect(messages({ dynamicPaths: 'all' })).toEqual([
        'state.dynamicPaths: must be one of off, wildcard; the default "off" is kept',
      ]);
    });
  });
});

describe('loading the state section', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-state-config-'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const load = (config: unknown): LoadedBalk2Config => {
    fs.writeFileSync(path.join(rootDir, '.balk2.json'), JSON.stringify(config), 'utf8');
    return loadBalk2ConfigDetailed(rootDir);
  };

  it('loads a valid section alongside other settings', () => {
    const loaded = load({ output: 'out', state: { roots: ['appState'] } });
    expect(loaded.problems).toEqual([]);
    expect(loaded.config).toEqual({ output: 'out', state: { roots: ['appState'] } });
  });

  it('drops an unusable section and reports why', () => {
    const loaded = load({ output: 'out', state: { methods: [{ method: 'get' }] } });
    expect(loaded.config).toEqual({ output: 'out' });
    expect(loaded.problems.map((problem) => problem.path)).toEqual(['state.methods[0].access']);
  });

  it('reports a non-object section', () => {
    expect(load({ state: [] }).problems).toEqual([{ path: 'state', message: 'must be an object' }]);
  });
});