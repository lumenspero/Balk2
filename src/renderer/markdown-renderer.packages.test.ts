import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';
import { renderMarkdown } from './markdown-renderer.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00Z' };

/** The lines of one `## ` section, up to the next one. */
function section(markdown: string, heading: string): string {
  const parts = markdown.split('\n## ');
  const found = parts.find((part) => part.startsWith(`## ${heading}`) || part.startsWith(heading));
  if (!found) throw new Error(`No section ${heading}`);
  return found;
}

function boundaryMap(): ConnectionMap {
  const graph = new ConnectionGraph();
  graph.addFile('crates/core/src/lib.rs', 'rust');
  graph.addFile('crates/core/src/parse.rs', 'rust');
  graph.addFile('crates/ingest/src/main.rs', 'rust');
  graph.addFile('web/src/search.ts', 'typescript');
  graph.addFile('scripts/collect.py', 'python');
  graph.addFile('package.json', 'npm-manifest');
  graph.addPackage({
    kind: 'package',
    id: 'package:cargo:crates/core#lib:core',
    ecosystem: 'cargo',
    name: 'core',
    target: 'lib',
    manifest: 'crates/core/Cargo.toml',
    roots: ['crates/core/src/lib.rs'],
    edition: '2021',
  });
  graph.addPackage({
    kind: 'package',
    id: 'package:cargo:crates/ingest#bin:ingest',
    ecosystem: 'cargo',
    name: 'ingest',
    target: 'bin',
    manifest: 'crates/ingest/Cargo.toml',
    roots: ['crates/ingest/src/main.rs'],
  });
  graph.addPackage({
    kind: 'package',
    id: 'package:npm:web',
    ecosystem: 'npm',
    name: 'web',
    manifest: 'package.json',
    roots: ['web/src/search.ts'],
  });
  graph.addRelationship(
    'dependsOn',
    'package:cargo:crates/ingest#bin:ingest',
    'package:cargo:crates/core#lib:core',
    'high',
    { evidence: 'manifest', metadata: { kind: 'normal' } },
  );
  graph.addRelationship(
    'declaresModule',
    'crates/core/src/lib.rs',
    'crates/core/src/parse.rs',
    'high',
    {
      evidence: 'ast',
    },
  );
  graph.addRelationship('calls', 'web/src/search.ts', 'crates/core/src/lib.rs', 'high', {
    evidence: 'ast',
    metadata: { mechanism: 'wasm-bindgen' },
  });
  graph.addRelationship('imports', 'web/src/search.ts', 'crates/core/src/lib.rs', 'high', {
    evidence: 'ast',
    metadata: { loadKind: 'wasm-bindgen-module' },
  });
  graph.addRelationship('executes', 'scripts/collect.py', 'scripts/collect.py', 'high', {
    evidence: 'ast',
    metadata: { mechanism: 'process' },
  });
  return graph.build(METADATA);
}

describe('markdown: Packages', () => {
  it('groups packages by manifest, with target, roots and internal dependencies', () => {
    const md = renderMarkdown(boundaryMap());
    const packages = section(md, 'Packages');
    expect(packages).toContain('### crates/ingest/Cargo.toml');
    expect(packages).toContain('- **ingest (bin)**: cargo\n  Roots');
    expect(packages).toContain('  Roots: crates/ingest/src/main.rs');
    expect(packages).toContain('  Depends on: package:cargo:crates/core#lib:core (normal)');
    expect(packages).toContain('### package.json');
    expect(packages).toContain('- **web**: npm');
  });

  it('orders the manifests and packages deterministically', () => {
    const md = renderMarkdown(boundaryMap());
    const packages = section(md, 'Packages');
    const order = ['crates/core/Cargo.toml', 'crates/ingest/Cargo.toml', 'package.json'].map((m) =>
      packages.indexOf(`### ${m}`),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('is omitted when the repository declares no packages', () => {
    const graph = new ConnectionGraph();
    graph.addFile('src/a.ts', 'typescript');
    expect(renderMarkdown(graph.build(METADATA))).not.toContain('## Packages');
  });
});

describe('markdown: Rust module declarations', () => {
  it('shows declared modules and the declaring file on each file entry', () => {
    const md = renderMarkdown(boundaryMap());
    expect(md).toContain('Declares modules:\n  → crates/core/src/parse.rs');
    expect(md).toContain('Declared by:\n  ← crates/core/src/lib.rs');
  });
});

describe('markdown: Language Boundaries', () => {
  it('lists bindings and process executions, with mechanism and confidence', () => {
    const md = renderMarkdown(boundaryMap());
    const boundaries = section(md, 'Language Boundaries');
    expect(boundaries).toContain('### Bindings');
    expect(boundaries).toContain(
      '  web/src/search.ts → crates/core/src/lib.rs (wasm-bindgen, high)',
    );
    expect(boundaries).toContain(
      '  web/src/search.ts → crates/core/src/lib.rs (wasm-bindgen-module, high)',
    );
    expect(boundaries).toContain('### Process Execution');
    expect(boundaries).toContain('  scripts/collect.py → scripts/collect.py (high)');
  });

  it('is omitted when there are no bindings or executions', () => {
    const graph = new ConnectionGraph();
    graph.addFile('src/a.ts', 'typescript');
    expect(renderMarkdown(graph.build(METADATA))).not.toContain('## Language Boundaries');
  });
});
