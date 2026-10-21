import { describe, expect, it } from 'vitest';
import { runEventEngine } from './event-engine.js';
import type { EventCallFact } from './types.js';

const span = { filePath: 'src/a.ts', startLine: 2, startColumn: 1, endLine: 2, endColumn: 12 };
const scope = 'src/bus.ts:bus';
const owner = 'src/a.ts:setup';

function call(overrides: Partial<EventCallFact> = {}): EventCallFact {
  return {
    kind: 'event-call',
    filePath: 'src/a.ts',
    span,
    owner,
    subject: 'bus.on(ready, …)',
    direction: 'subscribe',
    relationship: 'subscribes',
    protocolSource: 'built-in',
    eventLikeReceiver: true,
    once: false,
    claimed: false,
    receiver: {
      identity: { kind: 'resolved', scope, confidence: 'high' },
      qualifies: true,
      qualificationEvidence: 'ts-program',
    },
    name: { kind: 'static', name: 'ready' },
    ...overrides,
  };
}

const unqualified = (direction: EventCallFact['direction']): EventCallFact =>
  call({
    direction,
    relationship: direction === 'emit' ? 'emits' : 'dispatches',
    receiver: {
      identity: { kind: 'resolved', scope, confidence: 'high' },
      qualifies: false,
      qualificationEvidence: 'ts-program',
      reason: 'receiver type lacks a subscribe method',
    },
  });

describe('runEventEngine', () => {
  it('links a subscription to its channel, from the subscribing owner', () => {
    expect(runEventEngine({ facts: [call()] })).toEqual([
      {
        kind: 'channel',
        name: 'ready',
        scope,
        relationship: 'subscribes',
        from: owner,
        confidence: 'high',
        evidence: 'ts-program',
        span,
      },
    ]);
  });

  it('attributes a subscription to its listener, and records who registered it', () => {
    const [edge] = runEventEngine({ facts: [call({ listener: 'src/l.ts:onReady' })] });
    expect(edge).toMatchObject({
      kind: 'channel',
      from: 'src/l.ts:onReady',
      metadata: { registeredBy: owner },
    });
  });

  it('records once and listener options as metadata', () => {
    const [edge] = runEventEngine({
      facts: [call({ once: true, options: { capture: true } })],
    });
    expect(edge).toMatchObject({ metadata: { once: true, capture: true } });
  });

  it('attributes an unsubscription to the owner, and records its listener', () => {
    const [edge] = runEventEngine({
      facts: [
        call({
          direction: 'unsubscribe',
          relationship: 'unsubscribes',
          listener: 'src/l.ts:onReady',
        }),
      ],
    });
    expect(edge).toMatchObject({
      kind: 'channel',
      from: owner,
      metadata: { listener: 'src/l.ts:onReady' },
    });
  });

  it('reports a dynamic name on a qualifying receiver', () => {
    expect(
      runEventEngine({
        facts: [call({ name: { kind: 'dynamic', reason: 'name is a variable' } })],
      }),
    ).toEqual([
      {
        kind: 'observe',
        relationship: 'subscribes',
        from: owner,
        reason: 'dynamic-event-name',
        subject: 'bus.on(ready, …)',
        detail: 'name is a variable',
        span,
      },
    ]);
  });

  it('reports an unknown receiver identity on a qualifying call', () => {
    const facts = [
      call({
        receiver: {
          identity: { kind: 'unknown', reason: 'receiver type is any' },
          qualifies: true,
          qualificationEvidence: 'ts-program',
        },
      }),
    ];
    expect(runEventEngine({ facts })).toEqual([
      expect.objectContaining({
        kind: 'observe',
        reason: 'unknown-event-receiver',
        detail: 'receiver type is any',
      }),
    ]);
  });

  it('notes an unrecognized event-like receiver with a static name, using a default reason', () => {
    const facts = [
      call({
        receiver: {
          identity: { kind: 'resolved', scope, confidence: 'high' },
          qualifies: false,
          qualificationEvidence: 'ts-program',
        },
      }),
    ];
    expect(runEventEngine({ facts })).toEqual([
      expect.objectContaining({
        kind: 'observe',
        reason: 'unknown-event-receiver',
        detail: 'receiver is not recognized as an event emitter',
      }),
    ]);
  });

  it('ignores an unqualified receiver that is not event-like', () => {
    const facts = [
      call({ eventLikeReceiver: false, receiver: { ...call().receiver, qualifies: false } }),
    ];
    expect(runEventEngine({ facts })).toEqual([]);
  });

  it('treats an unqualified emitter as an emitter when the scope is also subscribed to', () => {
    const edges = runEventEngine({ facts: [call(), unqualified('emit')] });
    expect(edges[1]).toMatchObject({
      kind: 'channel',
      relationship: 'emits',
      from: owner,
      evidence: 'heuristic',
      confidence: 'medium',
    });
  });

  it('counts claimed calls as evidence, but emits nothing for them', () => {
    const edges = runEventEngine({
      facts: [call({ claimed: true }), unqualified('emit')],
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ kind: 'channel', evidence: 'heuristic' });
  });

  it('skips a call whose name is not a name at all', () => {
    expect(runEventEngine({ facts: [call({ name: { kind: 'not-a-name' } })] })).toEqual([]);
  });

  it('gives config evidence for a configured protocol, and medium confidence for a non-high receiver', () => {
    const [edge] = runEventEngine({
      facts: [
        call({
          protocolSource: 'config',
          receiver: {
            identity: { kind: 'resolved', scope, confidence: 'medium' },
            qualifies: true,
            qualificationEvidence: 'config',
          },
        }),
      ],
    });
    expect(edge).toMatchObject({ evidence: 'config', confidence: 'medium' });
  });
});
