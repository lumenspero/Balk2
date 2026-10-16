import { describe, expect, it } from 'vitest';
import type { RegistryFixture } from '../testing/registry-corpus.js';
import { analyzeRegistryFixture } from '../testing/registry-metrics.js';
import type { UnresolvedReferenceNode } from '../types.js';

const lines = (...rows: string[]): string => rows.join('\n');

// An untrusted registry produces no observations, so each fixture also registers a class under a
// static key. That makes the registry trusted, and the dynamic key below is then reported.
function dynamicKeyNodesOf(
  name: string,
  files: Record<string, string>,
): UnresolvedReferenceNode[] {
  const fixture: RegistryFixture = { name, files, pairs: [], observations: [] };
  const map = analyzeRegistryFixture(fixture);
  return Object.values(map.unresolved).filter((node) => node.reason === 'dynamic-registry-key');
}

describe('registry observation tiers: dynamic keys in built-in containers', () => {
  it('marks a private Map member with a dynamic key as internal', () => {
    const nodes = dynamicKeyNodesOf('private member', {
      'store.ts': lines(
        'export class Item {}',
        'export class Store {',
        '  private readonly entries = new Map<string, unknown>();',
        "  constructor() { this.entries.set('item', Item); }",
        '  add(key: string): void {',
        '    this.entries.set(key, 1);',
        '  }',
        '}',
      ),
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.tier).toBe('internal');
  });

  it('keeps an exported module-level Map with a dynamic key actionable', () => {
    const nodes = dynamicKeyNodesOf('exported registry', {
      'registry.ts': lines(
        'export class Item {}',
        'export const registry = new Map<string, unknown>();',
        "registry.set('item', Item);",
        'export function add(key: string): void {',
        '  registry.set(key, 1);',
        '}',
      ),
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.tier).toBeUndefined();
  });

  it('keeps a public class member Map with a dynamic key actionable', () => {
    const nodes = dynamicKeyNodesOf('public member', {
      'public-store.ts': lines(
        'export class Item {}',
        'export class PublicStore {',
        '  readonly entries = new Map<string, unknown>();',
        "  constructor() { this.entries.set('item', Item); }",
        '  add(key: string): void {',
        '    this.entries.set(key, 1);',
        '  }',
        '}',
      ),
    });
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.tier).toBeUndefined();
  });
});
