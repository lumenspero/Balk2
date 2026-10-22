import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConnectionGraphDetailed } from '../../../cli/build-graph.js';
import {
  evaluate,
  isActive,
  parseCfg,
  reachedWhenActive,
  rustcCfgSet,
  rustcReads,
} from '../../../testing/rust-oracle.js';

/**
 * The rustc oracle (V3 Phase 8.5). For each oracle workspace, Balk2's module tree for every crate
 * root must read exactly the files that rustc reads for that root. rustc reads a module file only
 * when its declaration is cfg-active, so Balk2's cfg text is evaluated against rustc's own cfg set
 * (`rustc --print cfg`), in the helpers in `src/testing/rust-oracle.ts`.
 *
 * Runs only when BALK2_RUST_ORACLE is set, as the `rust-oracle` CI job does. The predicate tests
 * always run.
 */

const ORACLE_ROOT = fileURLToPath(new URL('../../../../test/rust-oracle', import.meta.url));
const WORKSPACES = ['modules-basic', 'modules-paths', 'modules-cfg'] as const;
const ORACLE_ENABLED = process.env.BALK2_RUST_ORACLE !== undefined;

// ── predicate tests (always run) ────────────────────────────────────────────

describe('cfg predicates for the oracle (V3 Phase 8.5)', () => {
  const trueSet = new Set(['unix', 'target_os="linux"']);
  const check = (text: string): boolean => evaluate(parseCfg(text), trueSet);

  it('evaluates atoms, key-value atoms, all, any and not against the cfg set', () => {
    expect(check('cfg(unix)')).toBe(true);
    expect(check('cfg(windows)')).toBe(false);
    expect(check('cfg(target_os = "linux")')).toBe(true);
    expect(check('cfg(target_os = "macos")')).toBe(false);
    expect(check('cfg(all(unix, not(target_os = "macos")))')).toBe(true);
    expect(check('cfg(any(feature = "x", target_os = "linux"))')).toBe(true);
    expect(check('cfg(test)')).toBe(false);
  });

  it('treats a conjunction of conditions as true only when every one holds', () => {
    const conditions = 'cfg(unix) and cfg(test)';
    const edge = { from: 'a', to: 'b', cfg: conditions };
    expect(isActive(edge, trueSet)).toBe(false);
    expect(isActive({ ...edge, cfg: 'cfg(unix) and cfg(not(test))' }, trueSet)).toBe(true);
    expect(isActive({ ...edge, cfg: null }, trueSet)).toBe(true);
  });
});

// ── the oracle ──────────────────────────────────────────────────────────────

describe.skipIf(!ORACLE_ENABLED)('rustc oracle (V3 Phase 8.5)', () => {
  let trueSet: ReadonlySet<string>;
  let outDir: string;

  beforeAll(() => {
    trueSet = rustcCfgSet();
    outDir = mkdtempSync(path.join(tmpdir(), 'balk2-rustc-oracle-'));
  });

  afterAll(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  });

  for (const name of WORKSPACES) {
    it(`${name}: every crate reads exactly the files Balk2 reaches under its active declarations`, () => {
      const workspace = path.join(ORACLE_ROOT, name);
      const built = buildConnectionGraphDetailed(workspace);
      expect(built.moduleTree.unresolved).toEqual([]);
      expect(built.moduleTree.conflicts).toEqual([]);
      expect(built.moduleTree.crates.length).toBeGreaterThan(0);

      const read = new Set<string>();
      for (const crate of built.moduleTree.crates) {
        const actual = rustcReads(workspace, crate.root, outDir);
        for (const file of actual) read.add(file);
        expect(actual, `rustc reads for ${crate.root}`).toEqual(reachedWhenActive(crate, trueSet));
      }
      for (const file of built.moduleTree.unreachable) {
        expect(read.has(file), `${file} is reported unreachable but rustc reads it`).toBe(false);
      }
    });
  }

  it('modules-cfg: cfg-false files stay in the map but outside rustc reads', () => {
    const workspace = path.join(ORACLE_ROOT, 'modules-cfg');
    const built = buildConnectionGraphDetailed(workspace);
    const lib = built.moduleTree.crates.find((crate) => crate.root === 'src/lib.rs');
    expect(lib).toBeDefined();
    if (!lib) return;
    expect(lib.files).toContain('src/platform_win.rs');
    expect(lib.files).toContain('src/tests.rs');
    const actual = rustcReads(workspace, lib.root, outDir);
    expect(actual).not.toContain('src/platform_win.rs');
    expect(actual).not.toContain('src/tests.rs');
    expect(actual).toContain('src/platform.rs');
  });
});
