import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { describe, expect, it } from 'vitest';
import { buildConnectionGraphDetailed } from '../../cli/build-graph.js';
import { assertWithinBudget } from '../perf-budget.js';

/**
 * Phase 0.7 performance budget for Rust. Runs only with BALK2_PERF=1, because it generates and
 * scans a large crate. The first measured run sets the budget at 1.5x its time.
 */
const ENABLED = process.env.BALK2_PERF === '1';
const FILE_COUNT = 1000;
const CLASSES = 8;

/** One synthetic module: a use of a peer module, functions, structs, a trait and impls, and calls. */
function moduleText(index: number): string {
  const peer = (index * 7 + 3) % FILE_COUNT;
  const out: string[] = [
    `use crate::m${peer}::helper0 as peer_helper;`,
    '',
    'pub struct Point {',
    '    pub x: i64,',
    '    pub y: i64,',
    '}',
    '',
    'pub trait Shape {',
    '    fn area(&self) -> i64;',
    '}',
    '',
  ];
  for (let c = 0; c < CLASSES; c++) {
    out.push(
      `pub fn helper${c}(value: i64) -> i64 {`,
      `    value * ${c} + peer_helper(value)`,
      '}',
      '',
      `pub struct Base${c} {`,
      `    pub limit: i64,`,
      '}',
      '',
      `impl Shape for Base${c} {`,
      '    fn area(&self) -> i64 {',
      `        helper${c}(self.limit) + ${c}`,
      '    }',
      '}',
      '',
      `impl Base${c} {`,
      '    pub fn method(&self, value: i64) -> i64 {',
      `        helper${c}(value) + self.area()`,
      '    }',
      '}',
      '',
    );
  }
  return out.join('\n') + '\n';
}

describe.skipIf(!ENABLED)('Rust performance (Phase 0.7 budget)', () => {
  it('builds a 1,000-module synthetic Rust crate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-perf-rs-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'Cargo.toml'),
        '[package]\nname = "perf-lib"\nversion = "0.1.0"\nedition = "2021"\n',
      );
      const roots: string[] = [];
      let lines = 0;
      for (let i = 0; i < FILE_COUNT; i++) {
        roots.push(`pub mod m${i};`);
        const text = moduleText(i);
        lines += text.split('\n').length;
        fs.writeFileSync(path.join(dir, 'src', `m${i}.rs`), text, 'utf8');
      }
      fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), roots.join('\n') + '\n', 'utf8');

      const started = performance.now();
      const built = buildConnectionGraphDetailed(dir);
      const elapsedMs = performance.now() - started;

      console.log(
        `rust perf: ${FILE_COUNT} files, ${lines} lines, ${Math.round(elapsedMs)} ms, ` +
          `${built.graph.nodeCount} nodes, ${built.graph.relationshipCount} relationships`,
      );
      assertWithinBudget('rust', elapsedMs);
      expect(built.moduleProblems).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 600_000);
});
