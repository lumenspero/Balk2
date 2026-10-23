import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectionGraph } from '../cli/build-graph.js';
import type { Balk2Config } from '../config/balk2-config.js';

vi.setConfig({ testTimeout: 60_000 });

/** The high-confidence data edges that point at one artifact, from a repository with a config. */
function highEdgesTo(
  files: Record<string, string>,
  config: Balk2Config | undefined,
  artifact: string,
): string[] {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-pathbase-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(rootDir, name)), { recursive: true });
      fs.writeFileSync(path.join(rootDir, name), content, 'utf8');
    }
    const map = buildConnectionGraph(rootDir, config).build({
      generatedAt: '2026-01-01T00:00:00Z',
    });
    return map.relationships
      .filter(
        (r) =>
          r.to === artifact &&
          r.confidence === 'high' &&
          ['generates', 'consumes', 'reads'].includes(r.type),
      )
      .map((r) => `${r.type} ${r.from}`)
      .sort();
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
}

const FILES = {
  'lib/app.py':
    "import json\n\n\ndef load():\n    with open('cfg.json') as f:\n        return json.load(f)\n",
  'lib/cfg.json': '{}',
};

describe('data.pathBase in the analysis (Phase 11.4)', () => {
  it('places a bare path beside its caller by default', () => {
    expect(highEdgesTo(FILES, undefined, 'lib/cfg.json')).toEqual(['consumes lib/app.py']);
  });

  it('places a bare path at the root when the configured order is the root alone', () => {
    const config = { version: 2, data: { pathBase: ['repository'] } } as Balk2Config;
    expect(highEdgesTo(FILES, config, 'cfg.json')).toEqual(['consumes lib/app.py']);
    expect(highEdgesTo(FILES, config, 'lib/cfg.json')).toEqual([]);
  });

  it('applies an override for one language only to that language', () => {
    const config = { version: 2, data: { pathBase: { rust: ['repository'] } } } as Balk2Config;
    expect(highEdgesTo(FILES, config, 'lib/cfg.json')).toEqual(['consumes lib/app.py']);
  });
});
