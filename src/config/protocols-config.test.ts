import { describe, expect, it } from 'vitest';
import { normalizeProtocolsConfig, type NormalizedProtocolsConfig } from './protocols-config.js';

/** `path: message` lines, for readable assertions on what was reported. */
function problemsOf(result: NormalizedProtocolsConfig): string[] {
  return result.problems.map((problem) => `${problem.path}: ${problem.message}`);
}

const method = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  method: 'publish',
  direction: 'emit',
  eventArg: 0,
  ...overrides,
});

const events = (value: unknown): NormalizedProtocolsConfig =>
  normalizeProtocolsConfig({ events: value });

describe('normalizeProtocolsConfig: accepted configuration', () => {
  it('keeps a complete, valid events section unchanged', () => {
    const section = {
      builtIns: false,
      disable: ['dispatch'],
      methods: [
        {
          method: 'subscribe',
          direction: 'subscribe',
          eventArg: 0,
          listenerArg: 1,
          optionsArg: 2,
          once: true,
          receiver: { names: ['bus'], types: ['PubSub'] },
        },
        { method: 'publish', direction: 'emit', eventArg: 0, payloadArg: 1, receiver: 'any' },
        {
          method: 'fire',
          direction: 'dispatch',
          eventArg: 0,
          eventArgKind: 'event-object',
          receiver: 'event-like',
        },
      ],
    };

    const result = events(section);
    expect(result.problems).toEqual([]);
    expect(result.config).toEqual({ events: section });
  });

  it('accepts a minimal method and an explicit builtIns-only section', () => {
    expect(events({ methods: [method()] }).config).toEqual({
      events: { methods: [{ method: 'publish', direction: 'emit', eventArg: 0 }] },
    });
    expect(events({ builtIns: false }).config).toEqual({ events: { builtIns: false } });
  });
});

describe('normalizeProtocolsConfig: structure', () => {
  it('rejects a non-object protocols section', () => {
    for (const value of [null, 'x', 3, ['events']]) {
      const result = normalizeProtocolsConfig(value);
      expect(result.config).toBeUndefined();
      expect(problemsOf(result)).toEqual(['protocols: must be an object']);
    }
  });

  it('reports unknown protocol families', () => {
    const result = normalizeProtocolsConfig({ registries: {}, events: { builtIns: false } });

    expect(result.config).toEqual({ events: { builtIns: false } });
    expect(problemsOf(result)).toEqual([
      'protocols.registries: unknown protocol family ignored; only "events" is supported',
    ]);
  });

  it('reports unknown keys and wrong types in the events section', () => {
    const result = events({ builtIns: 'yes', extra: 1, methods: 'nope', disable: 'on' });

    expect(result.config).toBeUndefined();
    expect(problemsOf(result)).toEqual([
      'protocols.events.extra: unknown key ignored',
      'protocols.events.builtIns: must be true or false',
      'protocols.events.disable: must be an array of method names',
      'protocols.events.methods: must be an array',
    ]);
    expect(problemsOf(events('x'))).toEqual(['protocols.events: must be an object']);
  });
});

describe('normalizeProtocolsConfig: disable', () => {
  it('keeps built-in names and reports the rest', () => {
    const result = events({ disable: ['on', 'on', 'publish', 'not valid', 4] });

    expect(result.config).toEqual({ events: { disable: ['on'] } });
    expect(problemsOf(result)).toEqual([
      'protocols.events.disable[2]: "publish" is not a built-in method; nothing to disable',
      'protocols.events.disable[3]: must be a method name',
      'protocols.events.disable[4]: must be a method name',
    ]);
  });
});

describe('normalizeProtocolsConfig: methods that are rejected', () => {
  it.each([
    ['a non-object entry', 'x', 'protocols.events.methods[0]: must be an object; entry ignored'],
    [
      'a missing method name',
      { direction: 'emit', eventArg: 0 },
      'protocols.events.methods[0].method: must be a method name; entry ignored',
    ],
    [
      'an invalid method name',
      method({ method: 'bus.emit' }),
      'protocols.events.methods[0].method: must be a method name; entry ignored',
    ],
    [
      'an unknown direction',
      method({ direction: 'send' }),
      'protocols.events.methods[0].direction: must be one of subscribe, unsubscribe, emit, dispatch; entry ignored',
    ],
    [
      'a missing event argument',
      { method: 'publish', direction: 'emit' },
      'protocols.events.methods[0].eventArg: must be an integer from 0 to 15; entry ignored',
    ],
    [
      'a negative event argument',
      method({ eventArg: -1 }),
      'protocols.events.methods[0].eventArg: must be an integer from 0 to 15; entry ignored',
    ],
    [
      'a fractional event argument',
      method({ eventArg: 0.5 }),
      'protocols.events.methods[0].eventArg: must be an integer from 0 to 15; entry ignored',
    ],
    [
      'an event argument past the limit',
      method({ eventArg: 16 }),
      'protocols.events.methods[0].eventArg: must be an integer from 0 to 15; entry ignored',
    ],
    [
      'a receiver rule that is not recognized',
      method({ receiver: 'anything' }),
      'protocols.events.methods[0].receiver: must be "any", "event-like", or an object with names and/or types; entry ignored',
    ],
    [
      'a receiver rule listing nothing',
      method({ receiver: {} }),
      'protocols.events.methods[0].receiver: must list at least one valid name or type; entry ignored',
    ],
    [
      'a receiver rule with a bad name',
      method({ receiver: { names: ['bus', ''] } }),
      'protocols.events.methods[0].receiver.names[1]: must be a non-empty string',
    ],
    [
      'a receiver rule whose names are not an array',
      method({ receiver: { names: 'bus' } }),
      'protocols.events.methods[0].receiver.names: must be an array of strings',
    ],
    [
      'a payload argument that reuses the event argument',
      method({ payloadArg: 0 }),
      'protocols.events.methods[0].payloadArg: must differ from eventArg (both are 0); entry ignored',
    ],
    [
      'a listener argument that reuses the event argument',
      { method: 'sub', direction: 'subscribe', eventArg: 1, listenerArg: 1 },
      'protocols.events.methods[0].listenerArg: must differ from eventArg (both are 1); entry ignored',
    ],
    [
      'an options argument that reuses the listener argument',
      { method: 'sub', direction: 'subscribe', eventArg: 0, listenerArg: 2, optionsArg: 2 },
      'protocols.events.methods[0].optionsArg: must differ from listenerArg (both are 2); entry ignored',
    ],
  ])('rejects %s', (_label, entry, expected) => {
    const result = events({ methods: [entry] });

    expect(result.config).toBeUndefined();
    expect(problemsOf(result)).toContain(expected);
  });

  it('never widens a protocol by dropping a bad receiver rule', () => {
    const result = events({ methods: [method({ receiver: { types: [3] } })] });
    expect(result.config).toBeUndefined();
  });
});

describe('normalizeProtocolsConfig: fields that are dropped', () => {
  it('drops fields that do not apply to the direction but keeps the entry', () => {
    const result = events({
      methods: [
        method({ listenerArg: 1, optionsArg: 2, once: true }),
        {
          method: 'sub',
          direction: 'subscribe',
          eventArg: 0,
          payloadArg: 1,
          eventArgKind: 'event-object',
        },
      ],
    });

    expect(result.config).toEqual({
      events: {
        methods: [
          { method: 'publish', direction: 'emit', eventArg: 0 },
          { method: 'sub', direction: 'subscribe', eventArg: 0 },
        ],
      },
    });
    expect(problemsOf(result)).toEqual([
      'protocols.events.methods[0].listenerArg: only applies to subscribe and unsubscribe; field ignored',
      'protocols.events.methods[0].optionsArg: only applies to subscribe and unsubscribe; field ignored',
      'protocols.events.methods[0].once: only applies to subscribe; field ignored',
      'protocols.events.methods[1].eventArgKind: only applies to emit and dispatch; field ignored',
      'protocols.events.methods[1].payloadArg: only applies to emit and dispatch; field ignored',
    ]);
  });

  it('drops malformed optional fields and reports unknown keys', () => {
    const result = events({
      methods: [method({ payloadArg: 'one', once: 'yes', eventArgKind: 'blob', colour: 'red' })],
    });

    expect(result.config).toEqual({
      events: { methods: [{ method: 'publish', direction: 'emit', eventArg: 0 }] },
    });
    expect(problemsOf(result)).toEqual([
      'protocols.events.methods[0].colour: unknown key ignored',
      'protocols.events.methods[0].eventArgKind: has an unrecognized value; field ignored',
      'protocols.events.methods[0].payloadArg: must be an integer from 0 to 15; field ignored',
      'protocols.events.methods[0].once: must be true or false; field ignored',
    ]);
  });
});

describe('normalizeProtocolsConfig: duplicates', () => {
  it('keeps the first definition of a method and reports later ones', () => {
    const result = events({
      methods: [method({ eventArg: 0 }), method({ eventArg: 1 }), method({ method: 'other' })],
    });

    expect(result.config?.events?.methods?.map((m) => `${m.method}:${m.eventArg}`)).toEqual([
      'publish:0',
      'other:0',
    ]);
    expect(problemsOf(result)).toEqual([
      'protocols.events.methods[1].method: duplicate method "publish" ignored; first defined at methods[0]',
    ]);
  });

  it('keeps valid entries around a rejected one', () => {
    const result = events({ methods: ['bad', method()] });

    expect(result.config?.events?.methods).toHaveLength(1);
    expect(problemsOf(result)).toEqual([
      'protocols.events.methods[0]: must be an object; entry ignored',
    ]);
  });
});
