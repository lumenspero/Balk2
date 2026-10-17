import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadBalk2ConfigDetailed } from './index.js';

describe('.balk2.json version', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-version-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const load = (config: object): ReturnType<typeof loadBalk2ConfigDetailed> => {
    fs.writeFileSync(path.join(dir, '.balk2.json'), JSON.stringify(config));
    return loadBalk2ConfigDetailed(dir);
  };

  it('accepts version 2, the configuration format of 2.0.0', () => {
    expect(load({ version: 2 }).problems).toEqual([]);
  });

  it('accepts a configuration with no version', () => {
    expect(load({ include: ['src/**'] }).problems).toEqual([]);
  });

  it('reports any other version as a config problem', () => {
    const problems = load({ version: 1 }).problems;
    expect(problems).toEqual([
      {
        path: 'version',
        message: 'unsupported configuration version; this release reads version 2',
      },
    ]);
  });
});
