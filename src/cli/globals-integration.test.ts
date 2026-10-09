import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkConnectionMap } from './check.js';
import type { Relationship } from '../types.js';
import { generateConnectionMap, type GenerateResult } from './generate.js';

// Every generate/check builds a TypeScript program; the default 5s limit is tight under load.
vi.setConfig({ testTimeout: 30_000 });

const TIMESTAMP = '2026-01-01T00:00:00.000Z';

describe('duplicated globals through generate and check', () => {
  let rootDir: string;

  const write = (name: string, content: string): void => {
    fs.writeFileSync(path.join(rootDir, name), content, 'utf8');
  };

  const generate = (): GenerateResult =>
    generateConnectionMap({ cwd: rootDir, timestamp: TIMESTAMP });

  const reference = (result: GenerateResult, to: string): Relationship | undefined =>
    result.map.relationships.find(
      (r) => r.type === 'references' && r.from === 'main.js:run' && r.to === to,
    );

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-globals-integration-'));
    write('one.js', 'function init() {}');
    write('two.js', 'function init() {}');
    write('main.js', 'export function run() { init(); }');
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('shows the duplicate in the map, with the candidates and how to settle it', () => {
    const result = generate();
    const markdown = fs.readFileSync(result.mdPath, 'utf8');

    expect(Object.values(result.map.unresolved)).toHaveLength(1);
    expect(reference(result, 'one.js:init')).toBeUndefined();
    expect(reference(result, 'two.js:init')).toBeUndefined();

    expect(markdown).toContain('## Unresolved Observations');
    expect(markdown).toContain('- **Unresolved Observations**: 1');
    expect(markdown).toContain('Reason: ambiguous-global');
    expect(markdown).toContain(
      'Detail: "init" is declared in one.js and two.js; choose one with globals.targets',
    );
    expect(markdown).toContain('Candidates:\n  - one.js:init\n  - two.js:init');
  });

  it('settles the duplicate when .balk2.json chooses a file, and check agrees', () => {
    write('.balk2.json', JSON.stringify({ globals: { targets: { init: 'two.js' } } }));
    const result = generate();

    expect(result.map.unresolved).toEqual({});
    expect(reference(result, 'two.js:init')).toMatchObject({
      confidence: 'high',
      evidence: 'config',
    });
    expect(checkConnectionMap({ cwd: rootDir })).toMatchObject({ isCurrent: true });
  });

  it('reports the map as stale when the chosen file changes', () => {
    write('.balk2.json', JSON.stringify({ globals: { targets: { init: 'two.js' } } }));
    generate();

    write('.balk2.json', JSON.stringify({ globals: { targets: { init: 'one.js' } } }));
    expect(checkConnectionMap({ cwd: rootDir }).isCurrent).toBe(false);
  });

  it('keeps the observation when the chosen file is not a candidate', () => {
    write('.balk2.json', JSON.stringify({ globals: { targets: { init: 'elsewhere.js' } } }));
    const result = generate();

    expect(Object.values(result.map.unresolved)).toHaveLength(1);
  });
});
