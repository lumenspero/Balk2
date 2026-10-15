import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_REGISTRY_PROTOCOLS,
  RegistryProtocolCatalog,
  registryRelationshipOf,
} from './registry-protocols.js';

describe('built-in registry protocols', () => {
  it('maps each direction to its registry relationship', () => {
    expect(registryRelationshipOf('register')).toBe('registers');
    expect(registryRelationshipOf('resolve')).toBe('resolves');
    expect(registryRelationshipOf('route')).toBe('routesTo');
  });

  it('lists the built-in methods by direction, sorted', () => {
    const catalog = new RegistryProtocolCatalog();

    expect(catalog.methodsFor('register')).toEqual(['add', 'register', 'set']);
    expect(catalog.methodsFor('resolve')).toEqual(['create', 'get', 'load', 'resolve']);
    expect(catalog.methodsFor('route')).toEqual(['navigate']);
  });

  it('requires a registry-like receiver for every built-in', () => {
    const catalog = new RegistryProtocolCatalog();

    for (const protocol of BUILT_IN_REGISTRY_PROTOCOLS) {
      expect(catalog.forMethod(protocol.method)).toMatchObject({
        receiver: 'registry-like',
        source: 'built-in',
      });
    }
  });

  it('gives set a key and a target, and add a key alone', () => {
    const catalog = new RegistryProtocolCatalog();

    expect(catalog.forMethod('set')).toMatchObject({
      relationship: 'registers',
      keyArg: 0,
      valueArg: 1,
    });
    expect(catalog.forMethod('add')?.valueArg).toBeUndefined();
  });
});

describe('registry protocol configuration', () => {
  it('disable stops mapping a method but keeps it as evidence', () => {
    const catalog = new RegistryProtocolCatalog({ disable: ['set'] });

    expect(catalog.forMethod('set')).toBeUndefined();
    expect(catalog.evidenceMethodsFor('register')).toContain('set');
  });

  it('builtIns false removes the built-ins from mapping and from evidence', () => {
    const catalog = new RegistryProtocolCatalog({ builtIns: false });

    expect(catalog.all()).toEqual([]);
    expect(catalog.evidenceMethodsFor('register', 'resolve', 'route')).toEqual([]);
  });

  it('a configured method replaces the built-in of the same name, defaulting to any receiver', () => {
    const catalog = new RegistryProtocolCatalog({
      methods: [{ method: 'set', direction: 'register', keyArg: 1, valueArg: 0 }],
    });

    expect(catalog.forMethod('set')).toMatchObject({
      source: 'config',
      receiver: 'any',
      keyArg: 1,
      valueArg: 0,
    });
  });

  it('adds a configured route, counted as lookup evidence', () => {
    const catalog = new RegistryProtocolCatalog({
      methods: [{ method: 'lookupRoute', direction: 'route', keyArg: 0 }],
    });

    expect(catalog.forMethod('lookupRoute')?.relationship).toBe('routesTo');
    expect(catalog.evidenceMethodsFor('route')).toEqual(['lookupRoute', 'navigate']);
  });
});
