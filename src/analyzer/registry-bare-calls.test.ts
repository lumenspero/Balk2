import { describe, expect, it, vi } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { createRepositoryFixture } from '../testing/repository-fixture.js';
import type { ConnectionMap, RegistryKeyNode } from '../types.js';
import { JsTsAnalyzer, type RepositoryAnalysisOptions } from './js-ts-analyzer.js';

vi.setConfig({ testTimeout: 30_000 });

const META = { generatedAt: '2026-01-01T00:00:00Z' };
const COMPILER_OPTIONS = { target: 'es2020', strict: true };

/** A `commands` registry that a bare `invoke(...)` call looks in (Tauri's lookup side). */
const TAURI_OPTIONS: RepositoryAnalysisOptions = {
  registries: {
    methods: [{ method: 'invoke', direction: 'resolve', keyArg: 0, registry: 'commands' }],
    manifest: [{ registry: 'commands', key: 'greet', target: 'src/app.ts:greet' }],
  },
};

const FILES = {
  'src/app.ts': 'export function greet(): string {\n  return "hi";\n}\n',
  'src/bridge.ts': 'export function invoke(name: string): unknown {\n  return name;\n}\n',
  'src/caller.ts':
    "import { invoke } from './bridge';\n\nexport function load(): unknown {\n  return invoke('greet');\n}\n",
};

function analyze(
  files: Record<string, string>,
  options?: RepositoryAnalysisOptions,
): ConnectionMap {
  const fixture = createRepositoryFixture(files, COMPILER_OPTIONS);
  try {
    const graph = new ConnectionGraph();
    new JsTsAnalyzer().analyzeRepository(fixture.repository, graph, options);
    return graph.build(META);
  } finally {
    fixture.cleanup();
  }
}

function keyNode(map: ConnectionMap, key: string, scope: string): RegistryKeyNode {
  const found = Object.values(map.registryKeys).filter(
    (node) => node.key === key && node.scope === scope,
  );
  if (found.length !== 1)
    throw new Error(`Expected one key "${key}" in ${scope}, found ${found.length}`);
  return found[0]!;
}

describe('bare calls to a configured registry protocol (Tauri invoke)', () => {
  it('resolves a bare call to a key in the protocol registry', () => {
    const map = analyze(FILES, TAURI_OPTIONS);
    const key = keyNode(map, 'greet', 'commands');
    expect(
      map.relationships.some(
        (r) => r.type === 'resolves' && r.from === 'src/caller.ts:load' && r.to === key.id,
      ),
    ).toBe(true);
  });

  it('does not match a method call of the same name', () => {
    const map = analyze(
      {
        ...FILES,
        'src/caller.ts':
          "export function load(client: { invoke(name: string): unknown }): unknown {\n  return client.invoke('greet');\n}\n",
      },
      TAURI_OPTIONS,
    );
    const key = keyNode(map, 'greet', 'commands');
    expect(
      map.relationships.some(
        (r) => r.type === 'resolves' && r.from === 'src/caller.ts:load' && r.to === key.id,
      ),
    ).toBe(false);
  });

  it('reads nothing without the configured registry', () => {
    const map = analyze(FILES, {
      registries: { methods: [{ method: 'invoke', direction: 'resolve', keyArg: 0 }] },
    });
    expect(
      map.relationships.some((r) => r.type === 'resolves' && r.from === 'src/caller.ts:load'),
    ).toBe(false);
  });
});
