import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from '../graph.js';
import { findConnectionPaths, type PathFinderOptions } from './path-finder.js';

const META = { generatedAt: '2026-01-01T00:00:00Z' };

/** `[target] step | step | ...` for each path. */
function pathsOf(build: (graph: ConnectionGraph) => void, options?: PathFinderOptions): string[] {
  const graph = new ConnectionGraph();
  build(graph);
  return findConnectionPaths(graph.build(META), options).map(
    (path) => `[${path.target}] ${path.steps.join(' | ')}`,
  );
}

/** raw.json is produced by collect.js; build.js turns it into titles.parquet; load.ts reads that. */
function pipeline(graph: ConnectionGraph, storeReverse = false): void {
  graph.addArtifact('data/raw.json', 'json');
  graph.addArtifact('data/titles.parquet', 'parquet');
  const edges = [
    ['collect.js', 'data/raw.json', 'generates', 'generatedBy'],
    ['build.js', 'data/raw.json', 'consumes', 'consumedBy'],
    ['build.js', 'data/titles.parquet', 'generates', 'generatedBy'],
    ['load.ts', 'data/titles.parquet', 'consumes', 'consumedBy'],
  ] as const;
  for (const [from, to, forward, reverse] of edges) {
    graph.addRelationship(forward, from, to);
    if (storeReverse) graph.addRelationship(reverse, to, from);
  }
}

const FULL_CHAIN =
  '[data/raw.json] collect.js | → generates → | data/raw.json | ← consumed by ← | build.js | → generates → | data/titles.parquet | ← consumed by ← | load.ts';

describe('single-hop paths', () => {
  it('lists each reader of an artifact nothing produces', () => {
    expect(
      pathsOf((g) => {
        g.addArtifact('.balk2.json', 'json');
        g.addRelationship('reads', 'src/a.ts', '.balk2.json');
        g.addRelationship('reads', 'src/b.ts', '.balk2.json');
      }),
    ).toEqual([
      '[.balk2.json] src/a.ts | → reads → | .balk2.json',
      '[.balk2.json] src/b.ts | → reads → | .balk2.json',
    ]);
  });

  it('lists the producer of an artifact nothing consumes', () => {
    expect(
      pathsOf((g) => {
        g.addArtifact('data/raw.json', 'json');
        g.addRelationship('generates', 'collect.js', 'data/raw.json');
      }),
    ).toEqual(['[data/raw.json] collect.js | → generates → | data/raw.json']);
  });

  it('shows a script that reads back its own output as separate hops', () => {
    expect(
      pathsOf((g) => {
        g.addArtifact('data/cache.json', 'json');
        g.addRelationship('generates', 'cache.js', 'data/cache.json');
        g.addRelationship('consumes', 'cache.js', 'data/cache.json');
      }),
    ).toEqual([
      '[data/cache.json] cache.js | → generates → | data/cache.json',
      '[data/cache.json] cache.js | → consumes → | data/cache.json',
    ]);
  });
});

describe('paths through data artifacts', () => {
  it('connects a producer to a consumer through the artifact', () => {
    expect(
      pathsOf((g) => {
        g.addArtifact('data/raw.json', 'json');
        g.addRelationship('generates', 'collect.js', 'data/raw.json');
        g.addRelationship('consumes', 'build.js', 'data/raw.json');
      }),
    ).toEqual([
      '[data/raw.json] collect.js | → generates → | data/raw.json | ← consumed by ← | build.js',
    ]);
  });

  it('reads a multi-stage pipeline as one path without repeating its tail', () => {
    expect(pathsOf((g) => pipeline(g))).toEqual([FULL_CHAIN]);
  });

  it('gives the same paths whether or not reverse links are stored', () => {
    expect(pathsOf((g) => pipeline(g, true))).toEqual(pathsOf((g) => pipeline(g, false)));
    expect(pathsOf((g) => pipeline(g, true))).toEqual([FULL_CHAIN]);
  });

  it('derives the same paths from reverse links alone', () => {
    expect(
      pathsOf((g) => {
        g.addArtifact('data/raw.json', 'json');
        g.addArtifact('data/titles.parquet', 'parquet');
        g.addRelationship('generatedBy', 'data/raw.json', 'collect.js');
        g.addRelationship('consumedBy', 'data/raw.json', 'build.js');
        g.addRelationship('generatedBy', 'data/titles.parquet', 'build.js');
        g.addRelationship('consumedBy', 'data/titles.parquet', 'load.ts');
      }),
    ).toEqual([FULL_CHAIN]);
  });

  it('stops at maxDepth and then shows the rest as its own path', () => {
    expect(pathsOf((g) => pipeline(g), { maxDepth: 2 })).toEqual([
      '[data/raw.json] collect.js | → generates → | data/raw.json | ← consumed by ← | build.js',
      '[data/titles.parquet] build.js | → generates → | data/titles.parquet | ← consumed by ← | load.ts',
    ]);
  });

  it('falls back to single hops when the depth cannot fit a chain', () => {
    expect(pathsOf((g) => pipeline(g), { maxDepth: 1 })).toEqual([
      '[data/raw.json] collect.js | → generates → | data/raw.json',
      '[data/raw.json] build.js | → consumes → | data/raw.json',
      '[data/titles.parquet] build.js | → generates → | data/titles.parquet',
      '[data/titles.parquet] load.ts | → consumes → | data/titles.parquet',
    ]);
  });
});

describe('paths through event channels', () => {
  it('connects a publisher to its subscriber through the channel', () => {
    expect(
      pathsOf((g) => {
        const ready = g.addEventChannel('ready', 'src/bus.ts:bus').id;
        g.addRelationship('emits', 'src/net.ts:connect', ready);
        g.addRelationship('subscribes', 'src/ui.ts:onReady', ready);
      }),
    ).toEqual([
      '[event:src/bus.ts:bus#ready] src/net.ts:connect | → emits → | event:src/bus.ts:bus#ready | ← subscribed by ← | src/ui.ts:onReady',
    ]);
  });

  it('follows a cascade where a subscriber publishes the next event', () => {
    expect(
      pathsOf((g) => {
        const ready = g.addEventChannel('ready', 'src/bus.ts:bus').id;
        const loaded = g.addEventChannel('loaded', 'src/bus.ts:bus').id;
        g.addRelationship('emits', 'src/net.ts:connect', ready);
        g.addRelationship('subscribes', 'src/ui.ts:onReady', ready);
        g.addRelationship('emits', 'src/ui.ts:onReady', loaded);
        g.addRelationship('subscribes', 'src/view.ts:render', loaded);
      }),
    ).toEqual([
      '[event:src/bus.ts:bus#ready] src/net.ts:connect | → emits → | event:src/bus.ts:bus#ready | ← subscribed by ← | src/ui.ts:onReady | → emits → | event:src/bus.ts:bus#loaded | ← subscribed by ← | src/view.ts:render',
    ]);
  });

  it('treats dispatches like emits', () => {
    expect(
      pathsOf((g) => {
        const click = g.addEventChannel('click', 'global:document').id;
        g.addRelationship('dispatches', 'src/a.ts:fire', click);
        g.addRelationship('subscribes', 'src/b.ts:onClick', click);
      }),
    ).toEqual([
      '[event:global:document#click] src/a.ts:fire | → dispatches → | event:global:document#click | ← subscribed by ← | src/b.ts:onClick',
    ]);
  });

  it('ends cleanly when events form a cycle', () => {
    const paths = pathsOf((g) => {
      const first = g.addEventChannel('first').id;
      const second = g.addEventChannel('second').id;
      g.addRelationship('emits', 'a.ts:a', first);
      g.addRelationship('subscribes', 'b.ts:b', first);
      g.addRelationship('emits', 'b.ts:b', second);
      g.addRelationship('subscribes', 'a.ts:a', second);
    });

    expect(paths).toEqual([
      '[event:first] a.ts:a | → emits → | event:first | ← subscribed by ← | b.ts:b',
      '[event:second] b.ts:b | → emits → | event:second | ← subscribed by ← | a.ts:a',
    ]);
  });

  it('shows a listener-only channel as a single hop', () => {
    expect(
      pathsOf((g) => {
        const ready = g.addEventChannel('ready').id;
        g.addRelationship('subscribes', 'ui.ts:onReady', ready);
      }),
    ).toEqual(['[event:ready] ui.ts:onReady | → subscribes → | event:ready']);
  });

  it('can be switched off', () => {
    const build = (g: ConnectionGraph): void => {
      pipeline(g);
      const ready = g.addEventChannel('ready').id;
      g.addRelationship('emits', 'a.ts:a', ready);
      g.addRelationship('subscribes', 'b.ts:b', ready);
    };

    expect(pathsOf(build)).toHaveLength(2);
    expect(pathsOf(build, { includeEventChannels: false })).toEqual([FULL_CHAIN]);
  });
});

describe('what paths ignore', () => {
  it('skips unsubscriptions, unresolved observations and code relationships', () => {
    expect(
      pathsOf((g) => {
        const ready = g.addEventChannel('ready').id;
        g.addRelationship('unsubscribes', 'ui.ts:cleanup', ready);
        const unresolved = g.addUnresolved({
          reason: 'dynamic-event-name',
          attempted: 'emits',
          subject: 'bus.emit(name)',
          location: { filePath: 'a.ts', startLine: 1, startColumn: 1, endLine: 1, endColumn: 5 },
        });
        g.addRelationship('emits', 'a.ts:f', unresolved.id, 'low');
        g.addRelationship('imports', 'a.ts', 'b.ts');
        g.addRelationship('calls', 'a.ts:f', 'b.ts:g');
      }),
    ).toEqual([]);
  });
});

describe('limits and determinism', () => {
  const several = (g: ConnectionGraph): void => {
    for (const name of ['a', 'b']) {
      g.addArtifact(`data/${name}.json`, 'json');
      g.addRelationship('generates', `gen-${name}.js`, `data/${name}.json`);
      g.addRelationship('consumes', `use-${name}.js`, `data/${name}.json`);
    }
    const ready = g.addEventChannel('ready').id;
    g.addRelationship('emits', 'x.ts:x', ready);
    g.addRelationship('subscribes', 'y.ts:y', ready);
  };

  it('traces artifacts before event channels and honors the total limit', () => {
    expect(pathsOf(several).map((path) => path.split(']')[0])).toEqual([
      '[data/a.json',
      '[data/b.json',
      '[event:ready',
    ]);
    expect(pathsOf(several, { maxTotalPaths: 2 }).map((path) => path.split(']')[0])).toEqual([
      '[data/a.json',
      '[data/b.json',
    ]);
  });

  it('limits the paths per target', () => {
    const paths = pathsOf(
      (g) => {
        g.addArtifact('data/shared.json', 'json');
        for (const name of ['p1', 'p2', 'p3'])
          g.addRelationship('generates', `${name}.js`, 'data/shared.json');
        for (const name of ['c1', 'c2'])
          g.addRelationship('consumes', `${name}.js`, 'data/shared.json');
      },
      { maxPathsPerTarget: 2 },
    );

    expect(paths).toHaveLength(2);
  });

  it('is independent of the order relationships were added in', () => {
    const forwards = pathsOf((g) => pipeline(g));
    const backwards = pathsOf((g) => {
      g.addArtifact('data/titles.parquet', 'parquet');
      g.addArtifact('data/raw.json', 'json');
      g.addRelationship('consumes', 'load.ts', 'data/titles.parquet');
      g.addRelationship('generates', 'build.js', 'data/titles.parquet');
      g.addRelationship('consumes', 'build.js', 'data/raw.json');
      g.addRelationship('generates', 'collect.js', 'data/raw.json');
    });

    expect(backwards).toEqual(forwards);
  });
});
