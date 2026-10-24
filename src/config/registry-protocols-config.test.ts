import { describe, expect, it } from 'vitest';
import { normalizeProtocolsConfig, type NormalizedProtocolsConfig } from './protocols-config.js';

/** `path: message` lines, for readable assertions on what was reported. */
function problemsOf(result: NormalizedProtocolsConfig): string[] {
  return result.problems.map((problem) => `${problem.path}: ${problem.message}`);
}

const method = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  method: 'lookupRoute',
  direction: 'route',
  keyArg: 0,
  ...overrides,
});

const registries = (value: unknown): NormalizedProtocolsConfig =>
  normalizeProtocolsConfig({ registries: value });

describe('registry configuration: accepted', () => {
  it('keeps a complete, valid registries section unchanged', () => {
    const section = {
      builtIns: false,
      disable: ['get'],
      methods: [
        method(),
        {
          method: 'bind',
          direction: 'register',
          keyArg: 1,
          valueArg: 0,
          receiver: 'registry-like',
        },
        method({ method: 'pick', receiver: { names: ['picker'], types: ['Picker'] } }),
      ],
    };

    const result = registries(section);

    expect(result.config).toEqual({ registries: section });
    expect(result.problems).toEqual([]);
  });

  it('treats an empty registries section as no configuration', () => {
    const result = registries({});

    expect(result.config).toBeUndefined();
    expect(result.problems).toEqual([]);
  });
});

describe('registry configuration: rejected', () => {
  it('rejects a non-object registries section', () => {
    expect(problemsOf(registries('x'))).toEqual(['protocols.registries: must be an object']);
  });

  it('reports unknown keys and wrong types in the registries section', () => {
    expect(problemsOf(registries({ extra: 1, builtIns: 'no' }))).toEqual([
      'protocols.registries.extra: unknown key ignored',
      'protocols.registries.builtIns: must be true or false',
    ]);
  });

  it('drops a method with an unknown direction', () => {
    const result = registries({ methods: [method({ direction: 'emit' })] });

    expect(result.config).toBeUndefined();
    expect(problemsOf(result)).toEqual([
      'protocols.registries.methods[0].direction: must be one of register, resolve, route; entry ignored',
    ]);
  });

  it('drops a method without a usable key position', () => {
    const result = registries({ methods: [method({ keyArg: undefined })] });

    expect(result.config).toBeUndefined();
    expect(problemsOf(result)).toEqual([
      'protocols.registries.methods[0].keyArg: must be an integer from 0 to 15; entry ignored',
    ]);
  });

  it('drops valueArg on a lookup, keeping the method', () => {
    const result = registries({
      methods: [method({ method: 'get', direction: 'resolve', valueArg: 1 })],
    });

    expect(result.config?.registries?.methods).toEqual([
      { method: 'get', direction: 'resolve', keyArg: 0 },
    ]);
    expect(problemsOf(result)).toEqual([
      'protocols.registries.methods[0].valueArg: only applies to register; field ignored',
    ]);
  });

  it('drops a register method whose key and value positions clash', () => {
    const result = registries({
      methods: [method({ method: 'put', direction: 'register', keyArg: 1, valueArg: 1 })],
    });

    expect(result.config).toBeUndefined();
    expect(problemsOf(result)).toEqual([
      'protocols.registries.methods[0].valueArg: must differ from keyArg (both are 1); entry ignored',
    ]);
  });

  it('rejects an entry whose receiver rule is an event rule rather than widening it', () => {
    const result = registries({ methods: [method({ receiver: 'event-like' })] });

    expect(result.config).toBeUndefined();
    expect(problemsOf(result)).toEqual([
      'protocols.registries.methods[0].receiver: must be "registry-like", "any", or an object with names and/or types; entry ignored',
    ]);
  });

  it('rejects a receiver object that lists no valid name or type', () => {
    const result = registries({ methods: [method({ receiver: { names: [''] } })] });

    expect(result.config).toBeUndefined();
    expect(problemsOf(result)).toEqual([
      'protocols.registries.methods[0].receiver.names[0]: must be a non-empty string',
      'protocols.registries.methods[0].receiver: must list at least one valid name or type; entry ignored',
    ]);
  });

  it('reports disable entries that are not built-in registry methods', () => {
    expect(problemsOf(registries({ disable: ['publish', 'get', 3] }))).toEqual([
      'protocols.registries.disable[0]: "publish" is not a built-in method; nothing to disable',
      'protocols.registries.disable[2]: must be a method name',
    ]);
  });

  it('keeps the first of two methods with the same name', () => {
    const result = registries({
      methods: [
        method({ method: 'get', direction: 'resolve' }),
        method({ method: 'get', direction: 'route' }),
      ],
    });

    expect(result.config?.registries?.methods).toEqual([
      { method: 'get', direction: 'resolve', keyArg: 0 },
    ]);
    expect(problemsOf(result)).toEqual([
      'protocols.registries.methods[1].method: duplicate method "get" ignored; first defined at methods[0]',
    ]);
  });
});

describe('registry configuration: attributes, name injection and method registries', () => {
  it('keeps attribute rules, a name-injection rule and a method with a registry', () => {
    const section = {
      attributes: [
        { name: 'tauri::command', key: 'fn-name', registry: 'commands' },
        { name: 'app.route', key: { arg: 0 }, registry: 'routes' },
      ],
      nameInjection: [{ registry: 'fixtures', decorator: 'pytest.fixture' }],
      methods: [method({ method: 'invoke', direction: 'resolve', registry: 'commands' })],
    };

    const result = registries(section);

    expect(result.config).toEqual({ registries: section });
    expect(result.problems).toEqual([]);
  });

  it('reports an attribute key that is neither fn-name nor an argument index', () => {
    const result = registries({ attributes: [{ name: 'x', key: 'other', registry: 'r' }] });

    expect(problemsOf(result).length).toBeGreaterThan(0);
    expect(JSON.stringify(result.config ?? null)).not.toContain('"other"');
  });

  it('reports a method registry that is not a non-empty string and keeps no registry for it', () => {
    const result = registries({ methods: [method({ registry: '' })] });

    expect(problemsOf(result).length).toBeGreaterThan(0);
    expect(JSON.stringify(result.config ?? null)).not.toContain('"registry"');
  });
});
