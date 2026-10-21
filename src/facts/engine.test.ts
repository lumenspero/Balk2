import { describe, expect, it } from 'vitest';
import {
  entriesFor,
  filesFor,
  matchesCall,
  type CatalogEntry,
  type EngineInput,
  type MechanismEngine,
} from './engine.js';
import type { CallSite, FileFacts } from './types.js';

const span = { filePath: 'a.py', startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 };

function call(partial: Partial<CallSite>): CallSite {
  return {
    kind: 'call',
    filePath: 'a.py',
    span,
    owner: null,
    callee: { kind: 'unresolved', reason: 'dynamic-registry-key', subject: 'x' },
    positional: [],
    keyword: {},
    ...partial,
  };
}

describe('entriesFor', () => {
  it('keeps only entries that name the language', () => {
    const entries: CatalogEntry[] = [
      { languages: ['python'] },
      { languages: ['javascript', 'typescript'] },
      { languages: ['python', 'rust'] },
    ];
    expect(entriesFor(entries, 'python')).toHaveLength(2);
    expect(entriesFor(entries, 'rust')).toEqual([{ languages: ['python', 'rust'] }]);
  });
});

describe('matchesCall', () => {
  it('matches a resolved external callee by its name', () => {
    const read = call({ callee: { kind: 'external', name: 'std::fs::read_to_string' } });
    expect(matchesCall(read, { kind: 'resolved', target: 'std::fs::read_to_string' })).toBe(true);
    expect(matchesCall(read, { kind: 'resolved', target: 'fs::read_to_string' })).toBe(false);
  });

  it('matches a method on a resolved external receiver type', () => {
    const write = call({
      methodName: 'write_text',
      receiver: {
        identity: { kind: 'unknown' },
        type: { kind: 'external', name: 'pathlib.Path' },
      },
    });
    expect(matchesCall(write, { kind: 'resolved', target: 'pathlib.Path.write_text' })).toBe(true);
  });

  it('matches a method on a resolved symbol receiver type', () => {
    const save = call({
      methodName: 'save',
      receiver: { identity: { kind: 'unknown' }, type: { kind: 'symbol', id: 'src/b.ts:User' } },
    });
    expect(matchesCall(save, { kind: 'resolved', target: 'src/b.ts:User.save' })).toBe(true);
  });

  it('never matches by bare method text unless the entry allows any receiver', () => {
    const save = call({
      methodName: 'save',
      receiver: { identity: { kind: 'unknown' }, type: { kind: 'unknown' } },
    });
    expect(matchesCall(save, { kind: 'resolved', target: 'save' })).toBe(false);
    expect(matchesCall(save, { kind: 'method', method: 'save', receiver: 'any' })).toBe(true);
  });
});

describe('MechanismEngine', () => {
  it('runs over facts and a catalog for one family', () => {
    const counting: MechanismEngine<CatalogEntry & { name: string }, number> = {
      family: 'test',
      run: ({ files, catalog }: EngineInput<CatalogEntry & { name: string }>) =>
        files.length + catalog.length,
    };
    const files: FileFacts[] = [{ filePath: 'a.py', language: 'python', facts: [] }];
    const catalog = [{ name: 'x', languages: ['python' as const] }];
    expect(counting.run({ files, catalog })).toBe(2);
    expect(filesFor(files, 'python')).toHaveLength(1);
    expect(filesFor(files, 'rust')).toHaveLength(0);
  });
});
