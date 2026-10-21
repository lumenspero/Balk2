import { describe, expect, it } from 'vitest';
import {
  runMetadataEngine,
  UNRESOLVED_TARGET_DETAIL,
  type MetadataCatalogEntry,
} from './metadata-engine.js';
import type { CallSite, FileFacts } from './types.js';

const span = { filePath: 'src/m.ts', startLine: 1, startColumn: 1, endLine: 1, endColumn: 9 };
const catalog: MetadataCatalogEntry[] = [
  { key: 'route', defines: true, reads: true, languages: ['typescript'] },
  { key: 'readonly', reads: true, languages: ['typescript'] },
];

function reflect(name: string, positional: CallSite['positional']): CallSite {
  return {
    kind: 'call',
    filePath: 'src/m.ts',
    span,
    owner: 'src/m.ts:setup',
    name,
    methodName: name,
    text: `Reflect.${name}(...)`,
    positional,
    keyword: {},
  };
}

function run(facts: CallSite[]): ReturnType<typeof runMetadataEngine> {
  const files: FileFacts[] = [{ filePath: 'src/m.ts', language: 'typescript', facts }];
  return runMetadataEngine({ files, catalog });
}

const target = { kind: 'symbol' as const, id: 'src/m.ts:User' };

describe('runMetadataEngine', () => {
  it('links a defined target to the key, and a read owner to the key', () => {
    expect(
      run([
        reflect('defineMetadata', [
          { kind: 'string', value: 'route' },
          { kind: 'unknown' },
          target,
        ]),
        reflect('getMetadata', [{ kind: 'string', value: 'route' }, target]),
      ]),
    ).toEqual([
      { kind: 'defines', target: 'src/m.ts:User', key: 'route', span },
      { kind: 'reads', from: 'src/m.ts:setup', key: 'route', span },
    ]);
  });

  it('ignores a key with no protocol, a key without the direction, and non-name keys', () => {
    expect(run([reflect('getMetadata', [{ kind: 'string', value: 'other' }, target])])).toEqual([]);
    expect(
      run([
        reflect('defineMetadata', [
          { kind: 'string', value: 'readonly' },
          { kind: 'unknown' },
          target,
        ]),
      ]),
    ).toEqual([]);
    expect(run([reflect('getMetadata', [{ kind: 'not-a-name' }, target])])).toEqual([]);
  });

  it('reports a dynamic key as an observation attributed to the owner', () => {
    expect(
      run([reflect('getMetadata', [{ kind: 'dynamic', reason: 'computed key' }, target])]),
    ).toEqual([
      expect.objectContaining({
        kind: 'observation',
        attempted: 'readsMetadata',
        from: 'src/m.ts:setup',
        detail: 'computed key',
      }),
    ]);
  });

  it('reports a target with no symbol as an observation, for define and read alike', () => {
    expect(
      run([
        reflect('defineMetadata', [
          { kind: 'string', value: 'route' },
          { kind: 'unknown' },
          { kind: 'unknown' },
        ]),
        reflect('getMetadata', [{ kind: 'string', value: 'route' }, { kind: 'unknown' }]),
      ]),
    ).toEqual([
      expect.objectContaining({
        kind: 'observation',
        attempted: 'definesMetadata',
        detail: UNRESOLVED_TARGET_DETAIL,
      }),
      expect.objectContaining({
        kind: 'observation',
        attempted: 'readsMetadata',
        detail: UNRESOLVED_TARGET_DETAIL,
      }),
    ]);
  });

  it('does nothing without any configured keys', () => {
    const files: FileFacts[] = [
      {
        filePath: 'src/m.ts',
        language: 'typescript',
        facts: [reflect('getMetadata', [{ kind: 'dynamic', reason: 'x' }, target])],
      },
    ];
    expect(runMetadataEngine({ files, catalog: [] })).toEqual([]);
  });
});
