import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildConnectionGraphDetailed, type BuiltGraph } from '../../../cli/build-graph.js';
import { balk2Reads, parseDepInfo } from '../../../testing/rust-oracle.js';
import type { CrateModules } from './tree.js';

/**
 * The include and build-script fixtures (V3 Phase 10). These run without rustc: they check Balk2's
 * side of the oracle comparisons in rustc-oracle.test.ts, which compares the same workspaces with rustc.
 */

const ORACLE_ROOT = fileURLToPath(new URL('../../../../test/rust-oracle', import.meta.url));

function crateAt(built: BuiltGraph, root: string): CrateModules {
  const crate = built.moduleTree.crates.find((candidate) => candidate.root === root);
  if (!crate) throw new Error(`no crate root ${root}`);
  return crate;
}

describe('include and build-script fixtures (V3 Phase 10)', () => {
  it('includes-basic: the crate reads every file its include macros reach', () => {
    const built = buildConnectionGraphDetailed(path.join(ORACLE_ROOT, 'includes-basic'));
    expect(built.moduleTree.unresolved).toEqual([]);
    expect(balk2Reads(built.graph, crateAt(built, 'src/lib.rs'), new Set())).toEqual([
      'assets/blob.bin',
      'assets/config.json',
      'assets/page.html',
      'src/data.rs',
      'src/data.txt',
      'src/generated.rs',
      'src/lib.rs',
    ]);
  });

  it('build-script-basic: rerun-if-changed paths are read, and the OUT_DIR include depends on the build script', () => {
    const built = buildConnectionGraphDetailed(path.join(ORACLE_ROOT, 'build-script-basic'));
    expect(built.moduleTree.unresolved).toEqual([]);
    expect(balk2Reads(built.graph, crateAt(built, 'src/lib.rs'), new Set())).toEqual([
      'src/lib.rs',
    ]);
    const relationships = built.graph.getRelationships();
    const rerun = relationships
      .filter((rel) => rel.type === 'reads' && rel.metadata?.mechanism === 'build-script')
      .map((rel) => rel.to)
      .sort();
    expect(rerun).toEqual(['assets/schema.json', 'build-input.txt']);
    expect(
      relationships.some(
        (rel) => rel.type === 'dependsOn' && rel.metadata?.kind === 'build-output',
      ),
    ).toBe(true);
  });
});

describe('rustc dependency file parsing (V3 Phase 10)', () => {
  it('reads the inputs of the target line and skips phony targets and env-dep comments', () => {
    const text = [
      '/tmp/out/lib.rlib: src/lib.rs src/data.rs ../assets/page.html \\',
      '  /tmp/out/out/generated.rs',
      '',
      'src/lib.rs:',
      'src/data.rs:',
      '../assets/page.html:',
      '/tmp/out/out/generated.rs:',
      '# env-dep:BUILD_TAG=oracle',
      '# env-dep:OUT_DIR=/tmp/out/out',
      '',
    ].join('\n');
    expect(parseDepInfo(text)).toEqual([
      'src/lib.rs',
      'src/data.rs',
      '../assets/page.html',
      '/tmp/out/out/generated.rs',
    ]);
  });
});
