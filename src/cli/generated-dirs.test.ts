import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConnectionGraphDetailed } from './build-graph.js';
import { canonicalGraph } from '../testing/canonical-graph.js';

/**
 * Build output and virtual environments are not scanned (V3 Phase 16.6). A repository with a built
 * `target/`, a `.venv/` and a `node_modules/` must produce exactly the graph it produces without
 * them, and scanning it must take about as long. The generated directories hold many files, so a
 * scan that walked them would change the graph and slow down.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const GENERATED_FILES = 500;

function write(root: string, rel: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text, 'utf8');
}

/** A Rust crate, a Python package and a TypeScript package, each with a few modules. */
function sourceRepository(root: string): void {
  write(root, 'Cargo.toml', '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n');
  write(root, 'src/lib.rs', 'pub fn helper() -> i32 {\n    1\n}\n');
  for (let i = 0; i < 100; i++) {
    write(root, `pkg/m${i}.py`, `def f${i}():\n    return ${i}\n`);
    write(root, `web/src/m${i}.ts`, `export function f${i}(): number {\n  return ${i};\n}\n`);
  }
}

/** The directories a build or an install leaves behind, full of files that are not source. */
function generatedDirectories(root: string): void {
  write(root, 'target/debug/Cargo.lock.json', '{}\n');
  write(root, '.venv/pyvenv.cfg', 'home = /usr/bin\n');
  for (let i = 0; i < GENERATED_FILES; i++) {
    write(root, `target/debug/build/gen${i}.rs`, `pub fn gen${i}() -> i32 {\n    ${i}\n}\n`);
    write(
      root,
      `.venv/lib/python3.12/site-packages/dep${i}.py`,
      `def dep${i}():\n    return ${i}\n`,
    );
    write(root, `node_modules/dep${i}/index.ts`, `export const dep${i} = ${i};\n`);
  }
}

function makeRepo(withGenerated: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-generated-dirs-'));
  roots.push(root);
  sourceRepository(root);
  if (withGenerated) generatedDirectories(root);
  return root;
}

function graphOf(root: string): string {
  const { graph } = buildConnectionGraphDetailed(root);
  return canonicalGraph(graph.build({ generatedAt: '2026-01-01T00:00:00Z' }));
}

describe('generated directories are not scanned (V3 Phase 16.6)', () => {
  it('produces the same graph with and without target, .venv and node_modules', () => {
    expect(graphOf(makeRepo(true))).toBe(graphOf(makeRepo(false)));
  });

  it('keeps no node from a generated directory', () => {
    const text = graphOf(makeRepo(true));
    expect(text).not.toMatch(/target\/|\.venv\/|node_modules\//);
  });

  const TIMING = process.env.BALK2_PERF === '1';
  it.skipIf(!TIMING)(
    'scans about as fast with the generated directories as without them',
    () => {
      const plain = makeRepo(false);
      const full = makeRepo(true);
      const best = (root: string): number => {
        buildConnectionGraphDetailed(root); // warm up the TypeScript library parse
        const times: number[] = [];
        for (let run = 0; run < 3; run++) {
          const started = performance.now();
          buildConnectionGraphDetailed(root);
          times.push(performance.now() - started);
        }
        return Math.min(...times);
      };
      const plainMs = best(plain);
      const fullMs = best(full);
      console.log(
        `generated dirs: plain ${Math.round(plainMs)} ms, with generated ${Math.round(fullMs)} ms`,
      );
      expect(fullMs).toBeLessThanOrEqual(plainMs * 1.5 + 20);
    },
    120_000,
  );
});
