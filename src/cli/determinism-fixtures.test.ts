import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { generateConnectionMap } from './generate.js';

/**
 * Determinism on real repositories (V3 Phase 16.4). Every fixture under test/fixtures is generated
 * three ways: from a fresh copy, again from a second fresh copy, and from a copy whose files were
 * created in reverse order. The JSON and Markdown must be byte-identical in all three.
 *
 * When BALK2_DETERMINISM_OUT is set, a digest per fixture is written there. The determinism CI job
 * runs this on Linux and on Windows and fails if the two digest files differ, which checks the
 * output is the same across operating systems as well as across runs.
 */

// Each fixture is analyzed three times; the default 5s limit is too tight on a busy machine.
vi.setConfig({ testTimeout: 120_000 });

const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';
const FIXTURES = path.resolve(__dirname, '../../test/fixtures');
const DIGEST_OUT = process.env.BALK2_DETERMINISM_OUT;

const roots: string[] = [];
const digests: Record<string, string> = {};

/** Every file under a directory, as forward-slash paths relative to it, in sorted order. */
function listFiles(directory: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(directory, prefix)).sort()) {
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (fs.statSync(path.join(directory, rel)).isDirectory())
      out.push(...listFiles(directory, rel));
    else out.push(rel);
  }
  return out;
}

/** A fresh copy of a fixture, with its files created in the given order. */
function freshCopy(source: string, reverse: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-determinism-'));
  roots.push(dir);
  const files = listFiles(source);
  for (const rel of reverse ? [...files].reverse() : files) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(path.join(source, rel)));
  }
  return dir;
}

/** The output of one generation, read back from the files it wrote. */
function generate(cwd: string): { json: string; md: string } {
  const result = generateConnectionMap({ cwd, timestamp: FIXED_TIMESTAMP });
  return {
    json: fs.readFileSync(result.jsonPath, 'utf8'),
    md: fs.readFileSync(result.mdPath, 'utf8'),
  };
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const fixtureNames = fs
  .readdirSync(FIXTURES)
  .filter((name) => fs.statSync(path.join(FIXTURES, name)).isDirectory())
  .sort();

describe('connection map output is deterministic on real repositories (V3 Phase 16.4)', () => {
  afterAll(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    if (DIGEST_OUT) fs.writeFileSync(DIGEST_OUT, `${JSON.stringify(digests, null, 2)}\n`);
  });

  it('has fixtures to check', () => {
    expect(fixtureNames.length).toBeGreaterThan(0);
  });

  for (const name of fixtureNames) {
    it(name, () => {
      const source = path.join(FIXTURES, name);
      const first = generate(freshCopy(source, false));
      const repeated = generate(freshCopy(source, false));
      const reversed = generate(freshCopy(source, true));

      expect(first.json.length, 'output is not empty').toBeGreaterThan(0);
      expect(repeated.json, 'repeated run, JSON').toBe(first.json);
      expect(repeated.md, 'repeated run, Markdown').toBe(first.md);
      expect(reversed.json, 'reversed creation order, JSON').toBe(first.json);
      expect(reversed.md, 'reversed creation order, Markdown').toBe(first.md);

      digests[name] = sha256(`${first.json}\u0000${first.md}`);
    });
  }
});
