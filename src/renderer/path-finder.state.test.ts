import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import type { ConnectionMap } from '../types.js';
import { findConnectionPaths } from './path-finder.js';

const META = { generatedAt: '2026-01-01T00:00:00Z' };
const USER = 'state:src/store.ts:store#user';

/** collect.js writes raw.json, which load.ts reads; optionally both also touch shared state. */
function pipelineMap(withState: boolean): ConnectionMap {
  const graph = new ConnectionGraph();
  graph.addFile('collect.js', 'javascript');
  graph.addFile('load.ts', 'typescript');
  graph.addArtifact('data/raw.json', 'json');
  graph.addRelationship('generates', 'collect.js', 'data/raw.json');
  graph.addRelationship('consumes', 'load.ts', 'data/raw.json');
  if (withState) {
    const user = graph.addStatePath('src/store.ts:store', 'singleton', ['user']).id;
    graph.addRelationship('writesState', 'collect.js', user, 'high', { evidence: 'config' });
    graph.addRelationship('readsState', 'load.ts', user, 'high', { evidence: 'config' });
  }
  return graph.build(META);
}

describe('connection paths and shared state', () => {
  it('creates no path from state edges alone', () => {
    const graph = new ConnectionGraph();
    graph.addFile('src/a.ts', 'typescript');
    graph.addFile('src/b.ts', 'typescript');
    const user = graph.addStatePath('src/store.ts:store', 'singleton', ['user']).id;
    graph.addRelationship('writesState', 'src/a.ts', user, 'high', { evidence: 'config' });
    graph.addRelationship('readsState', 'src/b.ts', user, 'high', { evidence: 'config' });

    expect(findConnectionPaths(graph.build(META))).toEqual([]);
  });

  it('leaves the paths through an artifact unchanged by state edges on the same files', () => {
    const plain = findConnectionPaths(pipelineMap(false));
    const withState = findConnectionPaths(pipelineMap(true));

    expect(plain.length).toBeGreaterThan(0);
    expect(withState).toEqual(plain);
    expect(withState.some((path) => path.steps.join(' ').includes(USER))).toBe(false);
  });
});
