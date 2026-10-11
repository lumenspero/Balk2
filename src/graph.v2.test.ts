import { describe, expect, it } from 'vitest';
import { ConnectionGraph, eventChannelId } from './graph.js';
import type { SourceSpan } from './types.js';

const METADATA = { generatedAt: '2026-01-01T00:00:00Z' };

const span = (filePath: string, startLine: number, startColumn = 1): SourceSpan => ({
  filePath,
  startLine,
  startColumn,
  endLine: startLine,
  endColumn: startColumn + 5,
});

describe('event channel nodes', () => {
  it('identifies an unscoped channel by name', () => {
    const graph = new ConnectionGraph();
    const node = graph.addEventChannel('ready');

    expect(node).toEqual({ kind: 'event-channel', id: 'event:ready', name: 'ready' });
    expect(graph.hasEventChannel('event:ready')).toBe(true);
  });

  it('keeps channels with the same name but different scopes apart', () => {
    const graph = new ConnectionGraph();
    const socket = graph.addEventChannel('ready', 'src/net.ts:socket');
    const documentChannel = graph.addEventChannel('ready', 'global:document');
    const unscoped = graph.addEventChannel('ready');

    expect(socket.id).toBe('event:src/net.ts:socket#ready');
    expect(documentChannel.id).toBe('event:global:document#ready');
    expect(new Set([socket.id, documentChannel.id, unscoped.id]).size).toBe(3);
    expect(socket).toMatchObject({ name: 'ready', scope: 'src/net.ts:socket' });
  });

  it('is idempotent and exposes the id helper', () => {
    const graph = new ConnectionGraph();
    graph.addEventChannel('ready', 'a.ts:bus');
    graph.addEventChannel('ready', 'a.ts:bus');

    expect(graph.nodeCount).toBe(1);
    expect(eventChannelId('ready', 'a.ts:bus')).toBe('event:a.ts:bus#ready');
  });
});

describe('unresolved-reference nodes', () => {
  const input = {
    reason: 'ambiguous-global' as const,
    attempted: 'references' as const,
    subject: 'init',
    location: span('src/use.ts', 4, 3),
    candidates: ['b.ts:init', 'a.ts:init'],
  };

  it('derives a stable id from reason and location and sorts candidates', () => {
    const node = new ConnectionGraph().addUnresolved(input);

    expect(node.id).toBe('unresolved:ambiguous-global:src/use.ts:4:3');
    expect(node.candidates).toEqual(['a.ts:init', 'b.ts:init']);
    expect(node.kind).toBe('unresolved-reference');
  });

  it('keeps a detail sentence when given and omits it otherwise', () => {
    const graph = new ConnectionGraph();
    const withDetail = graph.addUnresolved({
      reason: 'unknown-event-receiver',
      attempted: 'emits',
      subject: 'getBus().emit(x)',
      location: span('src/use.ts', 12),
      detail: 'receiver is a computed expression',
    });
    const without = graph.addUnresolved({
      reason: 'dynamic-event-name',
      attempted: 'emits',
      subject: 'bus.emit(name)',
      location: span('src/use.ts', 13),
    });

    expect(withDetail.detail).toBe('receiver is a computed expression');
    expect('detail' in without).toBe(false);
  });

  it('is idempotent and omits absent candidates', () => {
    const graph = new ConnectionGraph();
    graph.addUnresolved(input);
    graph.addUnresolved(input);
    const dynamic = graph.addUnresolved({
      reason: 'dynamic-event-name',
      attempted: 'emits',
      subject: 'bus.emit(name)',
      location: span('src/use.ts', 9),
    });

    expect(graph.nodeCount).toBe(2);
    expect('candidates' in dynamic).toBe(false);
  });
});

describe('relationship detail', () => {
  it('carries evidence, spans and metadata when provided', () => {
    const graph = new ConnectionGraph();
    const rel = graph.addRelationship('subscribes', 'a.ts:on', 'event:ready', 'medium', {
      evidence: 'ts-program',
      spans: [span('a.ts', 3)],
      metadata: { once: true },
    });

    expect(rel).toEqual({
      type: 'subscribes',
      from: 'a.ts:on',
      to: 'event:ready',
      confidence: 'medium',
      evidence: 'ts-program',
      spans: [span('a.ts', 3)],
      metadata: { once: true },
    });
  });

  it('adds no detail keys to a plain relationship', () => {
    const rel = new ConnectionGraph().addRelationship('imports', 'a.ts', 'b.ts');
    expect(Object.keys(rel).sort()).toEqual(['confidence', 'from', 'to', 'type']);
  });

  it('merges repeated observations: spans combined, strongest confidence and its evidence win', () => {
    const graph = new ConnectionGraph();
    graph.addRelationship('emits', 'a.ts:f', 'event:go', 'low', {
      evidence: 'heuristic',
      spans: [span('a.ts', 9)],
    });
    graph.addRelationship('emits', 'a.ts:f', 'event:go', 'high', {
      evidence: 'ts-program',
      spans: [span('a.ts', 2), span('a.ts', 9)],
    });
    graph.addRelationship('emits', 'a.ts:f', 'event:go', 'medium', {
      evidence: 'ast',
      spans: [span('a.ts', 5)],
    });

    expect(graph.relationshipCount).toBe(1);
    expect(graph.getRelationships()[0]).toMatchObject({
      confidence: 'high',
      evidence: 'ts-program',
      spans: [span('a.ts', 2), span('a.ts', 5), span('a.ts', 9)],
    });
  });

  it('keeps only the metadata that holds for every observation', () => {
    const graph = new ConnectionGraph();
    graph.addRelationship('subscribes', 'a.ts:f', 'event:go', 'high', {
      metadata: { once: true, capture: true, registeredBy: 'a.ts:setup' },
    });
    graph.addRelationship('subscribes', 'a.ts:f', 'event:go', 'high', {
      metadata: { once: true, registeredBy: 'a.ts:reset' },
    });

    // `once` holds for both; `capture` is on one only; `registeredBy` differs.
    expect(graph.getRelationships()[0]?.metadata).toEqual({ once: true });
  });

  it('claims no metadata when any observation has none', () => {
    const graph = new ConnectionGraph();
    graph.addRelationship('subscribes', 'a.ts:f', 'event:go', 'high', { metadata: { once: true } });
    graph.addRelationship('subscribes', 'a.ts:f', 'event:go');

    expect(graph.getRelationships()[0]).not.toHaveProperty('metadata');
  });

  it('keeps identical metadata from repeated observations', () => {
    const graph = new ConnectionGraph();
    for (let i = 0; i < 2; i++) {
      graph.addRelationship('subscribes', 'a.ts:f', 'event:go', 'high', {
        metadata: { once: true, registeredBy: 'a.ts:setup' },
      });
    }

    expect(graph.getRelationships()[0]?.metadata).toEqual({
      once: true,
      registeredBy: 'a.ts:setup',
    });
  });
});

describe('build with virtual nodes', () => {
  it('emits schema version 2 with sorted virtual-node tables', () => {
    const graph = new ConnectionGraph();
    graph.addEventChannel('b');
    graph.addEventChannel('a');
    graph.addUnresolved({
      reason: 'dynamic-event-name',
      attempted: 'emits',
      subject: 'bus.emit(x)',
      location: span('z.ts', 1),
    });

    const map = graph.build(METADATA);
    expect(map.version).toBe(2);
    expect(Object.keys(map.eventChannels)).toEqual(['event:a', 'event:b']);
    expect(Object.keys(map.unresolved)).toEqual(['unresolved:dynamic-event-name:z.ts:1:1']);
    expect(graph.nodeCount).toBe(3);
  });

  it('is independent of insertion order', () => {
    const build = (order: readonly string[]): string => {
      const graph = new ConnectionGraph();
      for (const name of order) {
        graph.addEventChannel(name, 'a.ts:bus');
        graph.addRelationship('emits', 'a.ts:f', eventChannelId(name, 'a.ts:bus'), 'high', {
          spans: [span('a.ts', name.length)],
        });
      }
      return JSON.stringify(graph.build(METADATA));
    };

    expect(build(['x', 'yy', 'zzz'])).toBe(build(['zzz', 'x', 'yy']));
  });
});
