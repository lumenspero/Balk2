import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Balk2Config } from '../config/balk2-config.js';
import type { Relationship } from '../types.js';
import { buildConnectionGraph } from './build-graph.js';

const FILES: Record<string, string> = {
  'bus.ts': ['export function onReady(handler: () => void): void { handler(); }', ''].join('\n'),
  'app.ts': [
    "import { onReady } from './bus.js';",
    'export function ready(): void {}',
    'export function setup(): void {',
    '  onReady(ready);',
    '}',
    '',
  ].join('\n'),
};

/** `from -> to` for every passesCallback relationship. */
function callbackEdges(rels: readonly Relationship[]): string[] {
  return rels
    .filter((rel) => rel.type === 'passesCallback')
    .map((rel) => `${rel.from} -> ${rel.to}`)
    .sort();
}

describe('protocol languages reach the graph through the front end', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-protocol-languages-'));
    for (const [name, text] of Object.entries(FILES)) {
      fs.writeFileSync(path.join(dir, name), text);
    }
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const withCallback = (languages?: readonly string[]): Balk2Config => ({
    protocols: {
      callbacks: [
        {
          function: 'onReady',
          callbackArg: 0,
          ...(languages ? { languages: languages as never } : {}),
        },
      ],
    },
  });

  it('links the callback for an untagged entry', () => {
    const graph = buildConnectionGraph(dir, withCallback());
    expect(callbackEdges(graph.getRelationships())).toEqual(['app.ts:setup -> app.ts:ready']);
  });

  it('links the callback when the entry is tagged with the JS/TS family', () => {
    const graph = buildConnectionGraph(dir, withCallback(['typescript']));
    expect(callbackEdges(graph.getRelationships())).toEqual(['app.ts:setup -> app.ts:ready']);
  });

  it('does not link the callback when the entry is tagged for another language', () => {
    const graph = buildConnectionGraph(dir, withCallback(['python']));
    expect(callbackEdges(graph.getRelationships())).toEqual([]);
  });
});
