import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkConnectionMap } from './check.js';
import { generateConnectionMap } from './generate.js';
import { formatConfigWarnings } from './problem-warnings.js';

// Each integration case builds a TypeScript program; the default limit is tight under a parallel run.
vi.setConfig({ testTimeout: 30_000 });

describe('formatConfigWarnings', () => {
  it('names the file and the dotted location of each problem', () => {
    expect(
      formatConfigWarnings([{ path: 'state.globals', message: 'must be true, false, or a list' }]),
    ).toEqual(['balk2 warning: .balk2.json: state.globals: must be true, false, or a list']);
  });

  it('omits the location when a problem has none, such as an unreadable file', () => {
    expect(formatConfigWarnings([{ path: '', message: 'could not read or parse' }])).toEqual([
      'balk2 warning: .balk2.json: could not read or parse',
    ]);
  });

  it('is empty when nothing was dropped', () => {
    expect(formatConfigWarnings([])).toEqual([]);
  });
});

describe('warnings from generate and check', () => {
  let rootDir: string;

  const write = (name: string, content: string): void => {
    const full = path.join(rootDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-warnings-test-'));
    write('src/main.ts', 'export function run() { return 1; }');
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('reports a singleton whose module is not analyzed, without changing the map', () => {
    write(
      '.balk2.json',
      JSON.stringify({ state: { singletons: [{ module: 'src/missing.ts', export: 'store' }] } }),
    );
    const expected = [
      'balk2 warning: .balk2.json: state.singletons[0].module: "src/missing.ts" is not an analyzed file; entry ignored',
    ];

    const { warnings, map } = generateConnectionMap({
      cwd: rootDir,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(warnings).toEqual(expected);
    expect(Object.keys(map.statePaths)).toEqual([]);

    expect(checkConnectionMap({ cwd: rootDir }).warnings).toEqual(expected);
  });

  it('reports a configuration entry that was dropped', () => {
    write('.balk2.json', JSON.stringify({ state: { globals: 'store' } }));

    const { warnings } = generateConnectionMap({
      cwd: rootDir,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(warnings).toEqual([
      'balk2 warning: .balk2.json: state.globals: must be true, false, or an array of property names',
    ]);
  });

  it('reports nothing for a repository without a configuration file', () => {
    const { warnings } = generateConnectionMap({
      cwd: rootDir,
      timestamp: '2026-01-01T00:00:00.000Z',
    });
    expect(warnings).toEqual([]);
  });
});