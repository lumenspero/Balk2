import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { loadBalk2ConfigDetailed } from './balk2-config.js';

/** Loads a `.balk2.json` written with the given content. */
function load(content: unknown): ReturnType<typeof loadBalk2ConfigDetailed> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-python-config-'));
  try {
    fs.writeFileSync(path.join(dir, '.balk2.json'), JSON.stringify(content), 'utf8');
    return loadBalk2ConfigDetailed(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('python config section (5.5)', () => {
  it('reads identityDecorators', () => {
    const loaded = load({ version: 2, python: { identityDecorators: ['my_cache'] } });
    expect(loaded.config?.python).toEqual({ identityDecorators: ['my_cache'] });
    expect(loaded.problems).toEqual([]);
  });

  it('reports identityDecorators that is not a list of names', () => {
    const loaded = load({ version: 2, python: { identityDecorators: 'my_cache' } });
    expect(loaded.problems).toEqual([
      { path: 'python.identityDecorators', message: 'must be an array of non-empty strings' },
    ]);
  });

  it('reads roots in precedence order', () => {
    const loaded = load({ version: 2, python: { roots: ['src', '.'] } });
    expect(loaded.config?.python).toEqual({ roots: ['src', '.'] });
    expect(loaded.problems).toEqual([]);
  });

  it('reports roots that is not a list of names', () => {
    const loaded = load({ version: 2, python: { roots: [''] } });
    expect(loaded.problems).toEqual([
      { path: 'python.roots', message: 'must be an array of non-empty strings' },
    ]);
  });

  it('reports an unknown key in the python section', () => {
    const loaded = load({ version: 2, python: { sourceRoots: ['.'] } });
    expect(loaded.problems).toEqual([
      { path: 'python.sourceRoots', message: 'unknown key ignored' },
    ]);
  });
});
