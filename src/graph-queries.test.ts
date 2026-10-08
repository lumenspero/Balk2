import { describe, expect, it } from 'vitest';
import { ConnectionGraph } from './graph.js';
import {
  forwardRelationships,
  getEventReactions,
  getEventTriggers,
  getIncoming,
  getOutgoing,
} from './graph-queries.js';
import type { ConnectionMap } from './types.js';

const META = { generatedAt: '2026-01-01T00:00:00Z' };

/** A map storing both directions, as version 1 did. */
function storedBothWays(): ConnectionMap {
  const graph = new ConnectionGraph();
  graph.addRelationship('imports', 'src/main.ts', 'src/util.ts');
  graph.addRelationship('importedBy', 'src/util.ts', 'src/main.ts');
  graph.addRelationship('calls', 'src/main.ts:run', 'src/util.ts:help');
  graph.addRelationship('calledBy', 'src/util.ts:help', 'src/main.ts:run');
  graph.addRelationship('generates', 'scripts/build.js', 'data/out.json');
  graph.addRelationship('generatedBy', 'data/out.json', 'scripts/build.js');
  graph.addRelationship('consumes', 'src/load.ts', 'data/out.json');
  graph.addRelationship('consumedBy', 'data/out.json', 'src/load.ts');
  return graph.build(META);
}

/** The same facts with reverse links derived, as later versions store them. */
function storedForwardOnly(): ConnectionMap {
  const both = storedBothWays();
  const reverse = new Set(['importedBy', 'calledBy', 'generatedBy', 'consumedBy']);
  return { ...both, relationships: both.relationships.filter((rel) => !reverse.has(rel.type)) };
}

describe('forwardRelationships', () => {
  it('gives the same answer whether or not reverse links are stored', () => {
    expect(forwardRelationships(storedBothWays())).toEqual(
      forwardRelationships(storedForwardOnly()),
    );
  });

  it('turns stored reverse links around into their forward relationship', () => {
    const graph = new ConnectionGraph();
    graph.addRelationship('calledBy', 'src/util.ts:help', 'src/main.ts:run', 'medium', {
      evidence: 'ts-program',
    });

    expect(forwardRelationships(graph.build(META))).toEqual([
      {
        type: 'calls',
        from: 'src/main.ts:run',
        to: 'src/util.ts:help',
        confidence: 'medium',
        evidence: 'ts-program',
      },
    ]);
  });

  it('merges a fact stored in both directions, keeping the higher confidence', () => {
    const graph = new ConnectionGraph();
    graph.addRelationship('imports', 'a.ts', 'b.ts', 'low');
    graph.addRelationship('importedBy', 'b.ts', 'a.ts', 'high');

    expect(forwardRelationships(graph.build(META))).toEqual([
      { type: 'imports', from: 'a.ts', to: 'b.ts', confidence: 'high' },
    ]);
  });

  it('is sorted and unaffected by the order relationships were stored in', () => {
    const forward = forwardRelationships(storedBothWays()).map(
      (r) => `${r.type} ${r.from} ${r.to}`,
    );

    expect(forward).toEqual([...forward].sort());
    expect(forward).toHaveLength(4);
  });
});

describe('getOutgoing and getIncoming', () => {
  const map = storedBothWays();

  it('answers "who calls X?" and "what does X call?" directly', () => {
    expect(getIncoming(map, 'src/util.ts:help', 'calls').map((r) => r.from)).toEqual([
      'src/main.ts:run',
    ]);
    expect(getOutgoing(map, 'src/main.ts:run', 'calls').map((r) => r.to)).toEqual([
      'src/util.ts:help',
    ]);
  });

  it('answers "who imports this file?" the same way', () => {
    expect(getIncoming(map, 'src/util.ts', 'imports').map((r) => r.from)).toEqual(['src/main.ts']);
  });

  it('filters by relationship type, or returns everything when none is given', () => {
    expect(getIncoming(map, 'data/out.json').map((r) => r.type)).toEqual(['consumes', 'generates']);
    expect(getIncoming(map, 'data/out.json', 'generates').map((r) => r.from)).toEqual([
      'scripts/build.js',
    ]);
    expect(getIncoming(map, 'data/out.json', 'reads')).toEqual([]);
  });

  it('returns nothing for an unknown node', () => {
    expect(getOutgoing(map, 'nowhere.ts')).toEqual([]);
    expect(getIncoming(map, 'nowhere.ts')).toEqual([]);
  });
});

describe('event queries', () => {
  const graph = new ConnectionGraph();
  const ready = graph.addEventChannel('ready', 'src/bus.ts:bus').id;
  const loaded = graph.addEventChannel('loaded', 'src/bus.ts:bus').id;
  graph.addRelationship('emits', 'src/net.ts:connect', ready);
  graph.addRelationship('subscribes', 'src/ui.ts:onReady', ready);
  graph.addRelationship('subscribes', 'src/log.ts:onReady', ready);
  graph.addRelationship('unsubscribes', 'src/ui.ts:cleanup', ready);
  graph.addRelationship('emits', 'src/ui.ts:onReady', loaded);
  graph.addRelationship('dispatches', 'src/net.ts:connect', loaded);
  graph.addRelationship('subscribes', 'src/view.ts:render', loaded);
  const unresolved = graph.addUnresolved({
    reason: 'dynamic-event-name',
    attempted: 'emits',
    subject: 'bus.emit(name)',
    location: { filePath: 'src/net.ts', startLine: 9, startColumn: 3, endLine: 9, endColumn: 17 },
  });
  graph.addRelationship('emits', 'src/net.ts:connect', unresolved.id, 'low');
  const map = graph.build(META);

  it('says what reacts when a node publishes', () => {
    expect(getEventReactions(map, 'src/net.ts:connect')).toEqual([
      {
        channel: 'event:src/bus.ts:bus#loaded',
        via: 'dispatches',
        subscribers: ['src/view.ts:render'],
      },
      {
        channel: 'event:src/bus.ts:bus#ready',
        via: 'emits',
        subscribers: ['src/log.ts:onReady', 'src/ui.ts:onReady'],
      },
    ]);
  });

  it('says what can make a listener run', () => {
    expect(getEventTriggers(map, 'src/ui.ts:onReady')).toEqual([
      { channel: 'event:src/bus.ts:bus#ready', publishers: ['src/net.ts:connect'] },
    ]);
    expect(getEventTriggers(map, 'src/view.ts:render')).toEqual([
      {
        channel: 'event:src/bus.ts:bus#loaded',
        publishers: ['src/net.ts:connect', 'src/ui.ts:onReady'],
      },
    ]);
  });

  it('follows a listener that publishes in turn', () => {
    expect(getEventReactions(map, 'src/ui.ts:onReady')).toEqual([
      { channel: 'event:src/bus.ts:bus#loaded', via: 'emits', subscribers: ['src/view.ts:render'] },
    ]);
  });

  it('ignores unsubscriptions and unresolved observations', () => {
    expect(getEventTriggers(map, 'src/ui.ts:cleanup')).toEqual([]);
    expect(
      getEventReactions(map, 'src/net.ts:connect').some((r) => r.channel.startsWith('unresolved:')),
    ).toBe(false);
  });

  it('returns nothing for a node that takes no part in events', () => {
    expect(getEventReactions(map, 'src/other.ts:f')).toEqual([]);
    expect(getEventTriggers(map, 'src/other.ts:f')).toEqual([]);
  });
});
