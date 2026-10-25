import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { describe, expect, it } from 'vitest';
import { buildConnectionGraphDetailed } from '../cli/build-graph.js';
import { assertWithinBudget } from './perf-budget.js';

/**
 * Phase 0.7 performance budget for Python. Runs only with BALK2_PERF=1, because it generates
 * and scans a large repository. The first measured run sets the budget at 1.5x its time.
 */
const ENABLED = process.env.BALK2_PERF === '1';
const FILE_COUNT = 1000;
const PACKAGES = 50;
const CLASSES = 8;

/** One synthetic module: imports across packages, module functions, classes, inheritance and calls. */
function moduleText(index: number): string {
  const peer = (index * 7 + 3) % FILE_COUNT;
  const out: string[] = [
    'from __future__ import annotations',
    'import functools',
    'from dataclasses import dataclass',
    `from pkg${peer % PACKAGES}.mod${peer} import helper_0 as peer_helper`,
    '',
    '',
  ];
  for (let c = 0; c < CLASSES; c++) {
    out.push(`def helper_${c}(value: int) -> int:`, `    return value * ${c}`, '', '');
  }
  out.push('@dataclass', 'class Point:', '    x: int', '    y: int', '', '');
  for (let c = 0; c < CLASSES; c++) {
    const base = c === 0 ? 'object' : `Base${c - 1}`;
    out.push(
      `class Base${c}(${base}):`,
      `    LIMIT = ${c}`,
      '',
      '    def method(self, value: int) -> int:',
      `        return helper_${c}(value) + self.LIMIT + peer_helper(value)`,
      '',
      '    @functools.lru_cache(maxsize=None)',
      '    def cached(self, value: int) -> int:',
      '        return self.method(value)',
      '',
      '',
    );
  }
  return out.join('\n') + '\n';
}

describe.skipIf(!ENABLED)('python performance (Phase 0.7 budget)', () => {
  it('builds a 1,000-file synthetic Python repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-perf-py-'));
    try {
      let lines = 0;
      for (let i = 0; i < FILE_COUNT; i++) {
        const dirPath = path.join(dir, `pkg${i % PACKAGES}`);
        fs.mkdirSync(dirPath, { recursive: true });
        const text = moduleText(i);
        lines += text.split('\n').length;
        fs.writeFileSync(path.join(dirPath, `mod${i}.py`), text, 'utf8');
      }

      const started = performance.now();
      const built = buildConnectionGraphDetailed(dir);
      const elapsedMs = performance.now() - started;

      console.log(
        `python perf: ${FILE_COUNT} files, ${lines} lines, ${Math.round(elapsedMs)} ms, ` +
          `${built.graph.nodeCount} nodes, ${built.graph.relationshipCount} relationships`,
      );
      assertWithinBudget('python', elapsedMs);
      expect(built.graph.relationshipCount).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
