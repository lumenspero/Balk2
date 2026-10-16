import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runQuery } from './query.js';
import { DEFAULT_LIMIT } from '../query/map-query.js';
import { serializeConnectionMap } from '../serialize.js';
import { buildMap } from '../testing/connection-map-builder.js';
import type { Relationship } from '../types.js';

const rel = (
  type: Relationship['type'],
  from: string,
  to: string,
  confidence: Relationship['confidence'] = 'high',
): Relationship => ({ type, from, to, confidence });

const RELATIONSHIPS: Relationship[] = [
  rel('imports', 'src/a.ts', 'src/b.ts', 'high'),
  rel('imports', 'src/b.ts', 'src/c.ts', 'low'),
  rel('emits', 'src/a.ts', 'user-created', 'medium'),
];

describe('balk2 query', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-query-test-'));
    const map = buildMap(
      { files: ['src/a.ts', 'src/b.ts', 'src/c.ts'], eventChannels: ['user-created'] },
      RELATIONSHIPS,
    );
    fs.writeFileSync(path.join(tmpDir, 'connection-map.json'), serializeConnectionMap(map));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Replace the map on disk with a hub file that imports `count` leaves. */
  const writeHubMap = (count: number): void => {
    const hub = Array.from({ length: count }, (_, i) =>
      rel('imports', 'src/hub.ts', `src/leaf${i}.ts`),
    );
    const map = buildMap({ files: ['src/hub.ts', ...hub.map((r) => r.to)] }, hub);
    fs.writeFileSync(path.join(tmpDir, 'connection-map.json'), serializeConnectionMap(map));
  };

  it('prints the one-hop neighborhood of a file as text lines', () => {
    const result = runQuery(['--focus', 'src/a.ts'], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toEqual([]);
    expect(result.stdout[0]).toBe('focus: src/a.ts (depth 1)');
    expect(result.stdout).toContain('src/a.ts --imports--> src/b.ts [high]');
    expect(result.stdout).toContain('src/a.ts --emits--> user-created [medium]');
    expect(result.stdout).not.toContain('src/b.ts --imports--> src/c.ts [low]');
  });

  it('accepts the --flag=value form', () => {
    const result = runQuery(['--focus=src/a.ts', '--depth=2', '--min-confidence=low'], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout[0]).toBe('focus: src/a.ts (depth 2)');
    expect(result.stdout).toContain('src/b.ts --imports--> src/c.ts [low]');
  });

  it('applies the family and confidence filters', () => {
    const result = runQuery(['--family', 'code', '--min-confidence', 'high'], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual(['src/a.ts --imports--> src/b.ts [high]']);
  });

  it('applies the node-kind filter', () => {
    const result = runQuery(['--node-kind', 'file', '--min-confidence', 'low'], tmpDir);
    expect(result.stdout).not.toContain('src/a.ts --emits--> user-created [medium]');
    expect(result.stdout).toHaveLength(2);
  });

  it('hides low-confidence relationships by default', () => {
    const hidden = runQuery(['--focus', 'src/b.ts'], tmpDir);
    expect(hidden.stdout).not.toContain('src/b.ts --imports--> src/c.ts [low]');
    const shown = runQuery(['--focus', 'src/b.ts', '--min-confidence', 'low'], tmpDir);
    expect(shown.stdout).toContain('src/b.ts --imports--> src/c.ts [low]');
  });

  it('prints an explicit line when nothing matches', () => {
    const result = runQuery(['--family', 'state'], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual(['no relationships match']);
  });

  it('prints JSON with the focus, total, and matching relationships', () => {
    const result = runQuery(['--focus', 'src/b.ts', '--json', '--min-confidence', 'low'], tmpDir);
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout.join('\n')) as {
      focus: string;
      total: number;
      truncated: boolean;
      relationships: Relationship[];
    };
    expect(parsed.focus).toBe('src/b.ts');
    expect(parsed.total).toBe(2);
    expect(parsed.truncated).toBe(false);
    expect(parsed.relationships.map((r) => `${r.from}->${r.to}`).sort()).toEqual([
      'src/a.ts->src/b.ts',
      'src/b.ts->src/c.ts',
    ]);
  });

  it('reads the map from an -o directory', () => {
    const outDir = path.join(tmpDir, 'custom');
    fs.mkdirSync(outDir);
    fs.renameSync(
      path.join(tmpDir, 'connection-map.json'),
      path.join(outDir, 'connection-map.json'),
    );
    const result = runQuery(['-o', 'custom', '--family', 'events'], tmpDir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual(['src/a.ts --emits--> user-created [medium]']);
  });

  it('fails with exit code 1 when no map has been generated', () => {
    fs.rmSync(path.join(tmpDir, 'connection-map.json'));
    const result = runQuery([], tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr[0]).toContain('run balk2 generate first');
  });

  it('fails with exit code 1 when the focus matches no node', () => {
    const result = runQuery(['--focus', 'src/missing.ts'], tmpDir);
    expect(result.exitCode).toBe(1);
    expect(result.stderr[0]).toContain('no node matches "src/missing.ts"');
  });

  it('rejects unknown options with exit code 2', () => {
    const result = runQuery(['--bogus'], tmpDir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr[0]).toContain('unknown option "--bogus"');
  });

  it('rejects a flag without a value', () => {
    const result = runQuery(['--focus'], tmpDir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr[0]).toContain('--focus needs a value');
  });

  it('rejects a non-numeric depth', () => {
    const result = runQuery(['--focus', 'src/a.ts', '--depth', 'deep'], tmpDir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr[0]).toContain('--depth must be a whole number');
  });

  it('rejects an unknown family and lists the valid ones', () => {
    const result = runQuery(['--family', 'imports'], tmpDir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr[0]).toContain('--family: unknown value "imports"');
    expect(result.stderr[0]).toContain('code, events');
  });

  it('rejects an unknown confidence level', () => {
    const result = runQuery(['--min-confidence', 'certain'], tmpDir);
    expect(result.exitCode).toBe(2);
    expect(result.stderr[0]).toContain('--min-confidence must be one of high, medium, low');
  });

  describe('limit', () => {
    it('caps output at the default limit and says how to see more', () => {
      writeHubMap(DEFAULT_LIMIT + 10);
      const result = runQuery(['--focus', 'src/hub.ts'], tmpDir);
      expect(result.exitCode).toBe(0);
      const relationshipLines = result.stdout.filter((line) => line.includes('--imports-->'));
      expect(relationshipLines).toHaveLength(DEFAULT_LIMIT);
      expect(result.stdout.at(-1)).toBe(
        `showing ${DEFAULT_LIMIT} of ${DEFAULT_LIMIT + 10} relationships; use --limit <n> or --no-limit to see more`,
      );
    });

    it('prints every relationship with --no-limit', () => {
      writeHubMap(DEFAULT_LIMIT + 10);
      const result = runQuery(['--focus', 'src/hub.ts', '--no-limit'], tmpDir);
      const relationshipLines = result.stdout.filter((line) => line.includes('--imports-->'));
      expect(relationshipLines).toHaveLength(DEFAULT_LIMIT + 10);
      expect(result.stdout.some((line) => line.startsWith('showing'))).toBe(false);
    });

    it('applies an explicit --limit=n', () => {
      writeHubMap(20);
      const result = runQuery(['--focus', 'src/hub.ts', '--limit', '5'], tmpDir);
      const relationshipLines = result.stdout.filter((line) => line.includes('--imports-->'));
      expect(relationshipLines).toHaveLength(5);
      expect(result.stdout.at(-1)).toBe(
        'showing 5 of 20 relationships; use --limit <n> or --no-limit to see more',
      );
    });

    it('reports total and truncated in JSON output', () => {
      writeHubMap(20);
      const result = runQuery(['--focus', 'src/hub.ts', '--limit', '5', '--json'], tmpDir);
      const parsed = JSON.parse(result.stdout.join('\n')) as {
        total: number;
        truncated: boolean;
        relationships: Relationship[];
      };
      expect(parsed.total).toBe(20);
      expect(parsed.truncated).toBe(true);
      expect(parsed.relationships).toHaveLength(5);
    });

    it('rejects a zero limit with exit code 2', () => {
      const result = runQuery(['--limit', '0'], tmpDir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr[0]).toContain('--limit must be a whole number of at least 1');
    });

    it('rejects --limit combined with --no-limit', () => {
      const result = runQuery(['--limit', '5', '--no-limit'], tmpDir);
      expect(result.exitCode).toBe(2);
      expect(result.stderr[0]).toContain('cannot be used together');
    });
  });
});
