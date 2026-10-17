import { describe, expect, it } from 'vitest';
import { findConnectionPaths } from './path-finder.js';
import { buildMap } from '../testing/connection-map-builder.js';
import type { ArtifactNode, ConnectionMap, Relationship } from '../types.js';

const rel = (type: Relationship['type'], from: string, to: string): Relationship => ({
  type,
  from,
  to,
  confidence: 'high',
});

// a writes X, b reads X and generates H, and H is read by c1, c2 and c3.
// H has four relationships, so a bound of 3 should stop the path at b.
function pipeline(): ConnectionMap {
  const base = buildMap({ files: ['a.py', 'b.py', 'c1.py', 'c2.py', 'c3.py'] }, [
    rel('writes', 'a.py', 'data/x.json'),
    rel('reads', 'b.py', 'data/x.json'),
    rel('generates', 'b.py', 'data/hub.json'),
    rel('consumes', 'c1.py', 'data/hub.json'),
    rel('consumes', 'c2.py', 'data/hub.json'),
    rel('consumes', 'c3.py', 'data/hub.json'),
  ]);
  return {
    ...base,
    artifacts: {
      'data/x.json': {} as ArtifactNode,
      'data/hub.json': {} as ArtifactNode,
    },
  };
}

describe('findConnectionPaths degree bound', () => {
  it('passes through a shared node below the bound', () => {
    const paths = findConnectionPaths(pipeline(), { maxDegree: 50 });
    const xPaths = paths.filter((p) => p.target === 'data/x.json');
    expect(xPaths.some((p) => p.steps.includes('data/hub.json'))).toBe(true);
  });

  it('stops at a shared node above the bound', () => {
    const paths = findConnectionPaths(pipeline(), { maxDegree: 3 });
    const xPaths = paths.filter((p) => p.target === 'data/x.json');
    expect(xPaths.length).toBeGreaterThan(0);
    for (const path of xPaths) {
      expect(path.steps).not.toContain('data/hub.json');
      expect(path.steps.at(-1)).toBe('b.py');
    }
  });

  it('still traces a hub when it is the target itself', () => {
    const paths = findConnectionPaths(pipeline(), { maxDegree: 3 });
    expect(paths.some((p) => p.target === 'data/hub.json')).toBe(true);
  });
});
