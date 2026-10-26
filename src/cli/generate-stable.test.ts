import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkConnectionMap } from './check.js';
import { generateConnectionMap } from './generate.js';

/**
 * `generate` leaves an unchanged repository alone (V3 Phase 16.5a). The pre-commit hook regenerates
 * the map and fails the commit whenever it changes a file, so a second run with no source change
 * must not rewrite the map or its Markdown, even though the clock has moved on.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-generate-stable-'));
  roots.push(root);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, 'utf8');
  }
  return root;
}

const PY = {
  'pkg/a.py': 'def helper():\n    return 1\n',
  'pkg/b.py': 'from a import helper\n\n\ndef run():\n    return helper()\n',
};

describe('generate keeps an unchanged map', () => {
  it('leaves the JSON and Markdown byte-identical when nothing but the clock changed', () => {
    const root = repoWith(PY);
    const first = generateConnectionMap({ cwd: root, timestamp: '2026-01-01T00:00:00.000Z' });
    const jsonBefore = fs.readFileSync(first.jsonPath, 'utf8');
    const mdBefore = fs.readFileSync(first.mdPath, 'utf8');

    const second = generateConnectionMap({ cwd: root, timestamp: '2026-06-01T00:00:00.000Z' });

    expect(fs.readFileSync(second.jsonPath, 'utf8')).toBe(jsonBefore);
    expect(fs.readFileSync(second.mdPath, 'utf8')).toBe(mdBefore);
    expect(second.map.repository.generatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rewrites the map with the new timestamp once a source file changes', () => {
    const root = repoWith(PY);
    generateConnectionMap({ cwd: root, timestamp: '2026-01-01T00:00:00.000Z' });
    fs.writeFileSync(
      path.join(root, 'pkg', 'a.py'),
      'def helper():\n    return 2\n\n\ndef extra():\n    return 3\n',
      'utf8',
    );

    const next = generateConnectionMap({ cwd: root, timestamp: '2026-06-01T00:00:00.000Z' });

    expect(next.map.repository.generatedAt).toBe('2026-06-01T00:00:00.000Z');
    expect(fs.readFileSync(next.jsonPath, 'utf8')).toContain('pkg/a.py:extra');
  });

  it('agrees with check: a freshly generated map is current', () => {
    const root = repoWith(PY);
    generateConnectionMap({ cwd: root, timestamp: '2026-01-01T00:00:00.000Z' });
    generateConnectionMap({ cwd: root, timestamp: '2026-06-01T00:00:00.000Z' });

    expect(checkConnectionMap({ cwd: root }).isCurrent).toBe(true);
  });
});
