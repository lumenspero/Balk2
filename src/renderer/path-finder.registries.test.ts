import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';
import { findConnectionPaths } from './path-finder.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00Z' };
const USER_KEY = 'registry:src/container.ts:container#user';

function registryMap(): ConnectionMap {
  const graph = new ConnectionGraph();
  graph.addFile('src/app.ts', 'typescript');
  graph.addFile('src/user.ts', 'typescript');
  graph.addSymbol('src/user.ts', 'User', 'class');
  graph.addSymbol('src/app.ts', 'lookup', 'function');

  const user = graph.addRegistryKey('user', 'src/container.ts:container').id;
  // An unused key: registered, but nothing looks it up.
  const unused = graph.addRegistryKey('unused', 'src/container.ts:container').id;
  graph.addRelationship('registers', user, 'src/user.ts:User', 'high');
  graph.addRelationship('resolves', 'src/app.ts:lookup', user);
  graph.addRelationship('registers', unused, 'src/user.ts:User', 'high');
  return graph.build(METADATA);
}

describe('registry paths', () => {
  it('traces a lookup through its key to what the key is registered to', () => {
    const paths = findConnectionPaths(registryMap());
    expect(paths).toContainEqual({
      target: USER_KEY,
      steps: ['src/app.ts:lookup', '→ resolves →', USER_KEY, '→ registers →', 'src/user.ts:User'],
    });
  });

  it('produces no path for a key with a registration but no lookup', () => {
    const paths = findConnectionPaths(registryMap());
    expect(paths.some((path) => path.target.endsWith('#unused'))).toBe(false);
  });

  it('leaves registry paths out when includeRegistryKeys is false', () => {
    const paths = findConnectionPaths(registryMap(), { includeRegistryKeys: false });
    expect(paths.some((path) => path.target.startsWith('registry:'))).toBe(false);
  });
});
