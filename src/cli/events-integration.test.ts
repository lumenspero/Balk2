import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkConnectionMap } from './check.js';
import { generateConnectionMap, type GenerateResult } from './generate.js';

// Every generate/check builds a TypeScript program; the default 5s limit is tight under load.
vi.setConfig({ testTimeout: 30_000 });

const TIMESTAMP = '2026-01-01T00:00:00.000Z';

const PUBLISH_CONFIG = {
  protocols: {
    events: {
      methods: [
        { method: 'publish', direction: 'emit', eventArg: 0 },
        { method: 'listen', direction: 'subscribe', eventArg: 0, listenerArg: 1 },
      ],
    },
  },
};

describe('event channels through generate and check', () => {
  let rootDir: string;

  const write = (name: string, content: string): void => {
    const full = path.join(rootDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };

  const generate = (): GenerateResult =>
    generateConnectionMap({ cwd: rootDir, timestamp: TIMESTAMP });

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-events-integration-'));
    write(
      'src/bus.ts',
      [
        'export class Emitter {',
        '  on(event: string, listener: () => void): void {}',
        '  emit(event: string): void {}',
        '}',
        'export const bus = new Emitter();',
      ].join('\n'),
    );
    write(
      'src/hub.ts',
      [
        'export class PubSub {',
        '  publish(event: string): void {}',
        '  listen(event: string, listener: () => void): void {}',
        '}',
        'export const hub = new PubSub();',
      ].join('\n'),
    );
    write(
      'src/app.ts',
      [
        "import { bus } from './bus.js';",
        "import { hub } from './hub.js';",
        'export function onReady(): void {}',
        "export function start(): void { bus.on('ready', onReady); hub.listen('x', onReady); }",
        "export function finish(): void { bus.emit('ready'); hub.publish('x'); }",
      ].join('\n'),
    );
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('maps the built-in protocols with no configuration', () => {
    const { map } = generate();

    expect(Object.keys(map.eventChannels)).toEqual(['event:src/bus.ts:bus#ready']);
    expect(
      map.relationships.some(
        (r) =>
          r.type === 'emits' &&
          r.from === 'src/app.ts:finish' &&
          r.to === 'event:src/bus.ts:bus#ready',
      ),
    ).toBe(true);
  });

  it('adds the project-specific protocols from .balk2.json', () => {
    write('.balk2.json', JSON.stringify(PUBLISH_CONFIG));
    const { map } = generate();

    expect(Object.keys(map.eventChannels)).toEqual([
      'event:src/bus.ts:bus#ready',
      'event:src/hub.ts:hub#x',
    ]);
    const publish = map.relationships.find(
      (r) => r.type === 'emits' && r.to === 'event:src/hub.ts:hub#x',
    );
    expect(publish).toMatchObject({
      from: 'src/app.ts:finish',
      evidence: 'config',
      confidence: 'high',
    });
    expect(
      map.relationships.some(
        (r) =>
          r.type === 'subscribes' &&
          r.from === 'src/app.ts:onReady' &&
          r.to === 'event:src/hub.ts:hub#x',
      ),
    ).toBe(true);
  });

  it('shows publishers and subscribers together in the Markdown map', () => {
    write('.balk2.json', JSON.stringify(PUBLISH_CONFIG));
    const markdown = fs.readFileSync(generate().mdPath, 'utf8');

    expect(markdown).toContain('## Event Channels');
    expect(markdown).toContain('### event:src/hub.ts:hub#x');
    expect(markdown).toContain('Emitted by:\n  ← src/app.ts:finish');
    expect(markdown).toContain('Subscribed by:\n  ← src/app.ts:onReady');
    expect(markdown).toContain('- **Event Channels**: 2');
  });

  it('reports the generated map as current, and stale once the protocol configuration changes', () => {
    write('.balk2.json', JSON.stringify(PUBLISH_CONFIG));
    generate();
    expect(checkConnectionMap({ cwd: rootDir })).toMatchObject({ isCurrent: true });

    write('.balk2.json', JSON.stringify({ protocols: { events: { builtIns: false } } }));
    expect(checkConnectionMap({ cwd: rootDir }).isCurrent).toBe(false);
  });

  it('keeps generating, with the built-ins, when a protocol entry is invalid', () => {
    write(
      '.balk2.json',
      JSON.stringify({
        protocols: { events: { methods: [{ method: 'publish', direction: 'send', eventArg: 0 }] } },
      }),
    );
    const { map } = generate();

    expect(Object.keys(map.eventChannels)).toEqual(['event:src/bus.ts:bus#ready']);
  });
});
