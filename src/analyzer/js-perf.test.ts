import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { describe, expect, it } from 'vitest';
import { buildConnectionGraphDetailed } from '../cli/build-graph.js';
import { assertWithinBudget } from './perf-budget.js';

/**
 * Phase 0.7 performance budget for JS/TS. Runs only with BALK2_PERF=1, because it generates and
 * scans a large repository. The first measured run sets the budget at 1.5x its time.
 */
const ENABLED = process.env.BALK2_PERF === '1';
const FILE_COUNT = 1000;
const PACKAGES = 50;
const CLASSES = 8;

/** One synthetic module: imports across packages, module functions, classes, state and calls. */
function moduleText(index: number): string {
  const peer = (index * 7 + 3) % FILE_COUNT;
  const out: string[] = [
    `import { helper0 as peerHelper } from '../pkg${peer % PACKAGES}/mod${peer}';`,
    "import type { Point } from './shapes';",
    '',
    'let counter = 0;',
    '',
  ];
  for (let c = 0; c < CLASSES; c++) {
    out.push(
      `export function helper${c}(value: number): number {`,
      `  counter += ${c};`,
      `  return value * ${c} + peerHelper(value);`,
      '}',
      '',
    );
  }
  for (let c = 0; c < CLASSES; c++) {
    const base = c === 0 ? '' : ` extends Base${c - 1}`;
    out.push(
      `export class Base${c}${base} {`,
      `  limit = ${c};`,
      '  method(value: number): number {',
      `    return helper${c}(value) + this.limit;`,
      '  }',
      '  cached(value: number): number {',
      '    return this.method(value);',
      '  }',
      '}',
      '',
    );
  }
  out.push('export const origin: Point = { x: 0, y: 0 };', '');
  return out.join('\n');
}

describe.skipIf(!ENABLED)('JS/TS performance (Phase 0.7 budget)', () => {
  it('builds a 1,000-file synthetic TypeScript repository', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-perf-js-'));
    try {
      let lines = 0;
      for (let i = 0; i < FILE_COUNT; i++) {
        const dirPath = path.join(dir, `pkg${i % PACKAGES}`);
        fs.mkdirSync(dirPath, { recursive: true });
        const text = moduleText(i);
        lines += text.split('\n').length;
        fs.writeFileSync(path.join(dirPath, `mod${i}.ts`), text, 'utf8');
      }
      fs.writeFileSync(
        path.join(dir, 'shapes.ts'),
        'export interface Point { x: number; y: number }\n',
      );

      const started = performance.now();
      const built = buildConnectionGraphDetailed(dir);
      const elapsedMs = performance.now() - started;

      console.log(
        `js perf: ${FILE_COUNT} files, ${lines} lines, ${Math.round(elapsedMs)} ms, ` +
          `${built.graph.nodeCount} nodes, ${built.graph.relationshipCount} relationships`,
      );
      assertWithinBudget('js', elapsedMs);
      expect(built.syntaxErrors).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
