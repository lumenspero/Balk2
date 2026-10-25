import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConnectionGraph } from '../cli/build-graph.js';
import type { ConnectionMap } from '../types.js';

let root: string;

function write(relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-json-'));
  write('data/unused.json', '{"unused": true}');
  write('data/static.json', '{"static": true}');
  write('data/required.json', '{"required": true}');
  write('data/dynamic.json', '{"dynamic": true}');
  write('data/commented.json', '{"commented": true}');
  write(
    'main.ts',
    [
      "import staticData from './data/static.json';",
      "// './data/commented.json' is named in a comment only",
      "export const required = require('./data/required.json');",
      "export const load = () => import('./data/dynamic.json');",
      'export const value = staticData;',
      '',
    ].join('\n'),
  );
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('JSON files in the connection map', () => {
  const build = (): ConnectionMap =>
    buildConnectionGraph(root).build({ generatedAt: '2026-01-01T00:00:00Z' });

  it('lists only the JSON files that code references, as json artifacts', () => {
    const map = build();
    const artifacts = Object.values(map.artifacts) as { path: string; format: string }[];
    expect(artifacts.map((a) => a.path).sort()).toEqual([
      'data/dynamic.json',
      'data/required.json',
      'data/static.json',
    ]);
    expect(artifacts.every((a) => a.format === 'json')).toBe(true);
  });

  it('draws an imports edge from the importing file to each referenced JSON file', () => {
    const map = build();
    const targets = map.relationships
      .filter(
        (r) => r.type === 'imports' && (r.from === 'main.ts' || r.from.startsWith('main.ts:')),
      )
      .map((r) => r.to)
      .sort();
    expect(targets).toEqual(['data/dynamic.json', 'data/required.json', 'data/static.json']);
  });
});
