import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaPath = path.join(repoRoot, 'schemas', 'balk2.schema.json');
const schema: object = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as object;
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

function check(config: unknown): { valid: boolean; errors: string[] } {
  const valid = validate(config) === true;
  const errors = (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`);
  return { valid, errors };
}

const SAMPLE = {
  $schema: './node_modules/@lumenspero/balk2/dist/balk2.schema.json',
  include: ['src/**/*.ts'],
  exclude: ['**/*.test.ts'],
  output: 'connection-map',
  data: {
    extensions: ['.json', '.parquet'],
    lineage: [
      { producer: 'scripts/collect.py', output: 'data/raw.json' },
      { input: ['data/raw.json'], producer: 'scripts/build.py', output: 'data/titles.parquet' },
      { consumer: 'src/loadTitles.ts', input: 'data/titles.parquet' },
    ],
  },
  globals: { roots: ['globalThis', 'window'], targets: { init: 'src/init.ts' } },
  protocols: {
    events: {
      builtIns: true,
      disable: ['once'],
      methods: [
        {
          method: 'on',
          direction: 'subscribe',
          eventArg: 0,
          listenerArg: 1,
          receiver: 'event-like',
        },
        {
          method: 'emit',
          direction: 'emit',
          eventArg: 0,
          payloadArg: 1,
          receiver: { names: ['bus'], types: ['EventBus'] },
        },
      ],
    },
    registries: {
      builtIns: false,
      methods: [
        { method: 'set', direction: 'register', keyArg: 0, valueArg: 1, receiver: 'registry-like' },
        { method: 'resolve', direction: 'resolve', keyFrom: 'typeArgument' },
      ],
      decorators: [{ name: 'Command', registry: 'commands', keyArg: 0 }],
      parameterDecorators: [{ name: 'Inject', registry: 'services' }],
      manifest: [{ registry: 'commands', key: 'build', target: 'src/commands/build.ts' }],
      discover: [{ glob: 'src/plugins/*.ts', registry: 'plugins' }],
    },
    loaders: [{ function: 'loadModule', specifierArg: 0, receiver: { names: ['loader'] } }],
    callbacks: [{ function: 'onReady', callbackArg: 1 }],
    metadata: [
      { key: 'release', defines: true },
      { key: 'owner', reads: true },
    ],
    resources: [{ function: 'openDb', specifierArg: 0 }],
  },
  state: {
    roots: ['store'],
    globals: ['appState'],
    singletons: [{ module: 'src/store.ts', export: 'store' }],
    builtIns: true,
    disable: ['localStorage'],
    methods: [
      { method: 'get', access: 'read', keyArg: 0, pathSeparator: '.' },
      { method: 'set', access: 'write', keyArg: 0 },
      { method: 'remove', access: 'delete' },
    ],
    dynamicPaths: 'wildcard',
  },
  annotations: [{ type: 'calls', from: 'src/a.ts', to: 'src/b.ts', confidence: 'high' }],
};

describe('balk2 configuration schema', () => {
  it('compiles in strict mode and accepts an empty object', () => {
    expect(check({}).valid).toBe(true);
  });

  it('accepts the full sample covering every section', () => {
    const result = check(SAMPLE);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('rejects an unknown top-level key', () => {
    expect(check({ bogus: 1 }).valid).toBe(false);
  });

  it('rejects an argument index above 15', () => {
    const config = {
      protocols: { events: { methods: [{ method: 'on', direction: 'subscribe', eventArg: 16 }] } },
    };
    expect(check(config).valid).toBe(false);
  });

  it('rejects an unknown event direction', () => {
    const config = {
      protocols: { events: { methods: [{ method: 'on', direction: 'listen', eventArg: 0 }] } },
    };
    expect(check(config).valid).toBe(false);
  });

  it('rejects a registry method that sets both keyArg and keyFrom', () => {
    const config = {
      protocols: {
        registries: {
          methods: [{ method: 'set', direction: 'register', keyArg: 0, keyFrom: 'typeArgument' }],
        },
      },
    };
    expect(check(config).valid).toBe(false);
  });

  it('rejects a registry method with neither keyArg nor keyFrom', () => {
    const config = {
      protocols: { registries: { methods: [{ method: 'set', direction: 'register' }] } },
    };
    expect(check(config).valid).toBe(false);
  });

  it('rejects an annotation confidence outside high, medium, low', () => {
    const config = {
      annotations: [{ type: 'calls', from: 'a', to: 'b', confidence: 'certain' }],
    };
    expect(check(config).valid).toBe(false);
  });

  it('rejects a global root that is not an identifier', () => {
    expect(check({ globals: { roots: ['not-valid'] } }).valid).toBe(false);
  });

  it('rejects metadata that sets neither defines nor reads', () => {
    expect(check({ protocols: { metadata: [{ key: 'k' }] } }).valid).toBe(false);
  });

  it('rejects an unknown state access mode', () => {
    const config = { state: { methods: [{ method: 'get', access: 'modify' }] } };
    expect(check(config).valid).toBe(false);
  });

  it('rejects an unknown key inside a nested entry', () => {
    const config = {
      protocols: { callbacks: [{ function: 'onReady', callbackArg: 1, extra: true }] },
    };
    expect(check(config).valid).toBe(false);
  });

  const repoConfigPath = path.join(repoRoot, '.balk2.json');
  it.skipIf(!fs.existsSync(repoConfigPath))('accepts this repository .balk2.json', () => {
    const config: unknown = JSON.parse(fs.readFileSync(repoConfigPath, 'utf8'));
    const result = check(config);
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  const distSchemaPath = path.join(repoRoot, 'dist', 'balk2.schema.json');
  it.skipIf(!fs.existsSync(distSchemaPath))('ships a dist copy identical to the source', () => {
    expect(fs.readFileSync(distSchemaPath, 'utf8')).toBe(fs.readFileSync(schemaPath, 'utf8'));
  });
});
