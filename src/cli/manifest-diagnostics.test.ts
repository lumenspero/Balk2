import { describe, expect, it } from 'vitest';
import { buildMap } from '../testing/connection-map-builder.js';
import { collectDiagnostics, failureLines } from './diagnostics.js';

const problems = [
  {
    path: 'crates/app/Cargo.toml',
    message: 'bin target "tool" has no source file at "bin/tool.rs"',
  },
  { path: 'Cargo.toml', message: 'workspace member "crates/gone" matches no package' },
];

describe('manifest problems as diagnostics (V3 Phase 7.4)', () => {
  it('reports each manifest problem as a manifest diagnostic with no line', () => {
    const map = buildMap({ files: [] }, []);
    expect(collectDiagnostics(map, [], [], problems)).toEqual([
      {
        kind: 'manifest',
        path: 'Cargo.toml',
        message: 'workspace member "crates/gone" matches no package',
      },
      {
        kind: 'manifest',
        path: 'crates/app/Cargo.toml',
        message: 'bin target "tool" has no source file at "bin/tool.rs"',
      },
    ]);
  });

  it('keeps the existing output when no manifest problems are passed', () => {
    const map = buildMap({ files: [] }, []);
    expect(collectDiagnostics(map, [], [])).toEqual(collectDiagnostics(map, [], [], []));
  });

  it('--fail-on manifest selects them', () => {
    const map = buildMap({ files: [] }, []);
    const lines = failureLines(collectDiagnostics(map, [], [], problems), ['manifest']);
    expect(lines).toEqual([
      'balk2 diagnostic [manifest]: Cargo.toml: workspace member "crates/gone" matches no package',
      'balk2 diagnostic [manifest]: crates/app/Cargo.toml: bin target "tool" has no source file at "bin/tool.rs"',
      'balk2: 2 diagnostics matched --fail-on (manifest)',
    ]);
  });
});
