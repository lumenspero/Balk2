import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_EVENT_PROTOCOLS,
  EventProtocolCatalog,
  relationshipOf,
  type EventProtocol,
} from './event-protocols.js';

describe('built-in catalog', () => {
  const catalog = new EventProtocolCatalog();

  it('contains exactly the conservative set from the plan', () => {
    expect(catalog.all().map((protocol) => protocol.method)).toEqual([
      'addEventListener',
      'dispatch',
      'dispatchEvent',
      'emit',
      'off',
      'on',
      'once',
      'removeEventListener',
    ]);
    expect(BUILT_IN_EVENT_PROTOCOLS).toHaveLength(8);
  });

  it('describes direction, event argument and payload argument for each protocol', () => {
    expect(catalog.forMethod('on')).toMatchObject({
      direction: 'subscribe',
      relationship: 'subscribes',
      eventArg: 0,
      listenerArg: 1,
      eventArgKind: 'name',
      once: false,
    });
    expect(catalog.forMethod('emit')).toMatchObject({
      direction: 'emit',
      relationship: 'emits',
      eventArg: 0,
      payloadArg: 1,
    });
    expect(catalog.forMethod('dispatch')).toMatchObject({
      direction: 'dispatch',
      relationship: 'dispatches',
      payloadArg: 1,
    });
    expect(catalog.forMethod('off')).toMatchObject({
      direction: 'unsubscribe',
      relationship: 'unsubscribes',
    });
  });

  it('marks once as a one-time subscription and addEventListener as taking options', () => {
    expect(catalog.forMethod('once')).toMatchObject({ direction: 'subscribe', once: true });
    expect(catalog.forMethod('addEventListener')).toMatchObject({ optionsArg: 2, listenerArg: 1 });
    expect(catalog.forMethod('removeEventListener')).toMatchObject({ optionsArg: 2 });
  });

  it('reads the event from the constructed event object for dispatchEvent', () => {
    expect(catalog.forMethod('dispatchEvent')).toMatchObject({
      eventArg: 0,
      eventArgKind: 'event-object',
    });
  });

  it('trusts distinctive names outright and requires evidence for generic ones', () => {
    for (const method of ['addEventListener', 'removeEventListener', 'dispatchEvent']) {
      expect(catalog.forMethod(method)?.receiver).toBe('any');
    }
    for (const method of ['on', 'once', 'off', 'emit', 'dispatch']) {
      expect(catalog.forMethod(method)?.receiver).toBe('event-like');
    }
    expect(catalog.all().every((protocol) => protocol.source === 'built-in')).toBe(true);
  });

  it('does not match unrelated or inherited names', () => {
    expect(catalog.forMethod('publish')).toBeUndefined();
    expect(catalog.forMethod('constructor')).toBeUndefined();
    expect(catalog.forMethod('__proto__')).toBeUndefined();
  });

  it('groups methods by direction for receiver evidence', () => {
    expect(catalog.methodsFor('subscribe')).toEqual(['addEventListener', 'on', 'once']);
    expect(catalog.methodsFor('emit', 'dispatch')).toEqual(['dispatch', 'dispatchEvent', 'emit']);
  });
});

describe('relationshipOf', () => {
  it('maps every direction to its relationship', () => {
    expect(relationshipOf('subscribe')).toBe('subscribes');
    expect(relationshipOf('unsubscribe')).toBe('unsubscribes');
    expect(relationshipOf('emit')).toBe('emits');
    expect(relationshipOf('dispatch')).toBe('dispatches');
  });
});

describe('configured catalog', () => {
  const publish: EventProtocol = {
    method: 'publish',
    direction: 'emit',
    eventArg: 0,
    payloadArg: 1,
  };

  it('adds project-specific methods, defaulting their receiver to any', () => {
    const catalog = new EventProtocolCatalog({ methods: [publish] });

    expect(catalog.forMethod('publish')).toMatchObject({
      relationship: 'emits',
      receiver: 'any',
      source: 'config',
    });
    expect(catalog.forMethod('on')?.source).toBe('built-in');
    expect(catalog.all()).toHaveLength(9);
  });

  it('lets a configured method narrow its receiver', () => {
    const rule = { names: ['bus'], types: ['PubSub'] };
    const catalog = new EventProtocolCatalog({ methods: [{ ...publish, receiver: rule }] });

    expect(catalog.forMethod('publish')?.receiver).toEqual(rule);
  });

  it('replaces a built-in of the same name with the configured signature', () => {
    const catalog = new EventProtocolCatalog({
      methods: [{ method: 'emit', direction: 'emit', eventArg: 1, payloadArg: 0 }],
    });

    expect(catalog.forMethod('emit')).toMatchObject({
      eventArg: 1,
      payloadArg: 0,
      source: 'config',
      receiver: 'any',
    });
    expect(catalog.all()).toHaveLength(8);
  });

  it('removes disabled built-ins', () => {
    const catalog = new EventProtocolCatalog({ disable: ['dispatch', 'on'] });

    expect(catalog.forMethod('dispatch')).toBeUndefined();
    expect(catalog.forMethod('on')).toBeUndefined();
    expect(catalog.forMethod('emit')).toBeDefined();
    expect(catalog.all()).toHaveLength(6);
  });

  it('can switch the built-ins off entirely', () => {
    const catalog = new EventProtocolCatalog({ builtIns: false, methods: [publish] });

    expect(catalog.all().map((protocol) => protocol.method)).toEqual(['publish']);
    expect(new EventProtocolCatalog({ builtIns: false }).all()).toEqual([]);
  });

  it('still counts a disabled built-in as evidence of what an emitter looks like', () => {
    const catalog = new EventProtocolCatalog({ disable: ['emit', 'on'] });

    expect(catalog.methodsFor('emit', 'dispatch')).toEqual(['dispatch', 'dispatchEvent']);
    expect(catalog.evidenceMethodsFor('emit', 'dispatch')).toEqual([
      'dispatch',
      'dispatchEvent',
      'emit',
    ]);
    expect(catalog.evidenceMethodsFor('subscribe')).toEqual(['addEventListener', 'on', 'once']);
  });

  it('takes evidence from configured methods, and from no built-in once they are switched off', () => {
    const publish: EventProtocol = { method: 'publish', direction: 'emit', eventArg: 0 };

    expect(new EventProtocolCatalog({ methods: [publish] }).evidenceMethodsFor('emit')).toEqual([
      'emit',
      'publish',
    ]);
    expect(
      new EventProtocolCatalog({ builtIns: false, methods: [publish] }).evidenceMethodsFor(
        'emit',
        'dispatch',
      ),
    ).toEqual(['publish']);
    expect(new EventProtocolCatalog({ builtIns: false }).evidenceMethodsFor('subscribe')).toEqual(
      [],
    );
  });

  it('keeps a configured method even if its name was disabled', () => {
    const catalog = new EventProtocolCatalog({
      disable: ['emit'],
      methods: [{ method: 'emit', direction: 'emit', eventArg: 0 }],
    });

    expect(catalog.forMethod('emit')?.source).toBe('config');
  });
});
