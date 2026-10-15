import { describe, expect, it } from 'vitest';
import {
  getRegistrationTargets,
  getRegistryLookups,
  getRegistryResolutions,
} from './graph-queries.js';
import { ConnectionGraph } from './graph.js';
import type { ConnectionMap } from './types.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00Z' };

/** `user` is registered to User and looked up from lookup(); `admin` is looked up but never registered. */
function registryMap(): { map: ConnectionMap; user: string; admin: string } {
  const graph = new ConnectionGraph();
  graph.addFile('src/app.ts', 'typescript');
  graph.addFile('src/user.ts', 'typescript');
  graph.addSymbol('src/user.ts', 'User', 'class');
  graph.addSymbol('src/app.ts', 'lookup', 'function');
  graph.addSymbol('src/app.ts', 'other', 'function');

  const user = graph.addRegistryKey('user', 'src/container.ts:container').id;
  const admin = graph.addRegistryKey('admin', 'src/container.ts:container').id;
  graph.addRelationship('registers', user, 'src/user.ts:User');
  graph.addRelationship('resolves', 'src/app.ts:lookup', user);
  graph.addRelationship('routesTo', 'src/app.ts:other', admin);
  return { map: graph.build(METADATA), user, admin };
}

describe('registry queries', () => {
  it('reports, for a lookup, the key it resolves and what that key is registered to', () => {
    const { map, user } = registryMap();
    expect(getRegistryResolutions(map, 'src/app.ts:lookup')).toEqual([
      { key: user, relationship: 'resolves', targets: ['src/user.ts:User'] },
    ]);
  });

  it('reports no targets for a key that is looked up but never registered', () => {
    const { map, admin } = registryMap();
    expect(getRegistryResolutions(map, 'src/app.ts:other')).toEqual([
      { key: admin, relationship: 'routesTo', targets: [] },
    ]);
  });

  it('lists what a key is registered to, and who looks it up', () => {
    const { map, user } = registryMap();
    expect(getRegistrationTargets(map, user)).toEqual(['src/user.ts:User']);
    expect(getRegistryLookups(map, user)).toEqual(['src/app.ts:lookup']);
  });

  it('returns nothing for a node that does no registry lookups', () => {
    const { map } = registryMap();
    expect(getRegistryResolutions(map, 'src/user.ts:User')).toEqual([]);
  });
});
