import { describe, expect, it } from 'vitest';
import { isDataPathLiteral, joinPathParts, resolveRepoPath } from './path-value.js';

describe('joinPathParts', () => {
  it('treats a leading literal as cwd-relative', () => {
    expect(
      joinPathParts([
        { kind: 'literal', text: 'data' },
        { kind: 'literal', text: 'x.json' },
      ]),
    ).toEqual({
      kind: 'known',
      anchor: 'cwd',
      path: 'data/x.json',
    });
  });

  it('takes the anchor from a leading anchor part', () => {
    expect(
      joinPathParts([
        { kind: 'anchor', anchor: 'file-dir' },
        { kind: 'literal', text: '../data/x.json' },
      ]),
    ).toEqual({ kind: 'known', anchor: 'file-dir', path: '../data/x.json' });
  });

  it('is unknown when any part is unknown or an anchor follows the first part', () => {
    expect(joinPathParts([{ kind: 'literal', text: 'a' }, { kind: 'unknown' }])).toEqual({
      kind: 'unknown',
    });
    expect(
      joinPathParts([
        { kind: 'literal', text: 'a' },
        { kind: 'anchor', anchor: 'cwd' },
      ]),
    ).toEqual({ kind: 'unknown' });
    expect(joinPathParts([])).toEqual({ kind: 'unknown' });
  });
});

describe('resolveRepoPath', () => {
  it('resolves file-dir and package-dir anchors against their directories', () => {
    expect(
      resolveRepoPath(
        { kind: 'known', anchor: 'file-dir', path: '../data/x.json' },
        { fileDir: 'src/app' },
      ),
    ).toBe('src/data/x.json');
    expect(
      resolveRepoPath(
        { kind: 'known', anchor: 'package-dir', path: 'data/x.json' },
        { fileDir: '', packageDir: 'crates/ingest' },
      ),
    ).toBe('crates/ingest/data/x.json');
  });

  it('returns undefined for paths outside the repository or without the anchor', () => {
    expect(
      resolveRepoPath({ kind: 'known', anchor: 'cwd', path: '../x.json' }, { fileDir: '' }),
    ).toBeUndefined();
    expect(
      resolveRepoPath({ kind: 'known', anchor: 'cwd', path: '/etc/x.json' }, { fileDir: '' }),
    ).toBeUndefined();
    expect(
      resolveRepoPath({ kind: 'known', anchor: 'package-dir', path: 'x.json' }, { fileDir: '' }),
    ).toBeUndefined();
    expect(resolveRepoPath({ kind: 'unknown' }, { fileDir: '' })).toBeUndefined();
  });

  it('resolves the repository root for an empty relative path', () => {
    expect(resolveRepoPath({ kind: 'known', anchor: 'cwd', path: '.' }, { fileDir: '' })).toBe('');
  });
});

describe('isDataPathLiteral', () => {
  it('accepts repository data file names', () => {
    expect(isDataPathLiteral('data/titles.parquet')).toBe(true);
  });

  it('rejects URLs, web-root paths, templates, whitespace and bare extensions', () => {
    expect(isDataPathLiteral('https://example.com/x.json')).toBe(false);
    expect(isDataPathLiteral('/manifest.json')).toBe(false);
    expect(isDataPathLiteral('page_{n}.json')).toBe(false);
    expect(isDataPathLiteral('my file.json')).toBe(false);
    expect(isDataPathLiteral('.json')).toBe(false);
  });
});
