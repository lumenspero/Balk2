import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildConnectionGraphDetailed } from '../../../cli/build-graph.js';

const FIXTURE = fileURLToPath(new URL('../../../../test/fixtures/cargo-modules', import.meta.url));

describe('declaresModule in the connection map (V3 Phase 8.3)', () => {
  it('draws module edges from the crate root, with cfg as metadata', () => {
    const { graph } = buildConnectionGraphDetailed(FIXTURE);
    const edges = graph
      .getRelationships()
      .filter((rel) => rel.type === 'declaresModule' && !rel.to.startsWith('unresolved:'))
      .map((rel) => ({ from: rel.from, to: rel.to, cfg: rel.metadata?.cfg ?? null }));

    expect(edges).toEqual([
      { from: 'src/lib.rs', to: 'src/util.rs', cfg: null },
      { from: 'src/lib.rs', to: 'src/platform.rs', cfg: 'cfg(unix)' },
      { from: 'src/lib.rs', to: 'src/platform_win.rs', cfg: 'cfg(windows)' },
      {
        from: 'src/lib.rs',
        to: 'src/linux/tuning.rs',
        cfg: 'cfg(all(unix, not(target_os = "macos")))',
      },
      { from: 'src/lib.rs', to: 'src/gen/generated.rs', cfg: null },
      { from: 'src/util.rs', to: 'src/util/config.rs', cfg: null },
      { from: 'src/gen/generated.rs', to: 'src/gen/inner.rs', cfg: null },
    ]);
  });

  it('reports the conflict, the unresolved module and the orphan file (V3 Phase 8.4)', () => {
    const built = buildConnectionGraphDetailed(FIXTURE);
    expect(built.moduleProblems.map((problem) => [problem.kind, problem.path])).toEqual([
      ['module-conflict', 'src/lib.rs'],
      ['unreachable-module', 'src/orphan.rs'],
    ]);
    const unresolved = built.graph
      .getRelationships()
      .filter((rel) => rel.type === 'declaresModule' && rel.to.startsWith('unresolved:'));
    expect(unresolved.map((rel) => [rel.from, rel.to])).toEqual([
      ['src/lib.rs', 'unresolved:unresolved-module-path:src/lib.rs:18:1'],
    ]);
  });
});
