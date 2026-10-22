import { describe, expect, it } from 'vitest';
import {
  type InlineModule,
  type ModDeclaration,
  isModRsFile,
  moduleFileCandidates,
} from './paths.js';

function inline(name: string, pathAttr: string | null = null): InlineModule {
  return { name, pathAttr };
}

function decl(overrides: Partial<ModDeclaration> & Pick<ModDeclaration, 'file'>): ModDeclaration {
  return {
    modRs: false,
    inlineModules: [],
    pathAttr: null,
    name: 'foo',
    ...overrides,
  };
}

describe('isModRsFile', () => {
  it('treats crate roots and mod.rs files as mod-rs', () => {
    const none = { crateRoot: false, loadedByPath: false };
    expect(isModRsFile('src/lib.rs', { ...none, crateRoot: true })).toBe(true);
    expect(isModRsFile('src/a/mod.rs', none)).toBe(true);
    expect(isModRsFile('src/a.rs', none)).toBe(false);
  });

  it('treats a file loaded through #[path] as mod-rs', () => {
    expect(isModRsFile('src/gen/x.rs', { crateRoot: false, loadedByPath: true })).toBe(true);
  });
});

describe('moduleFileCandidates', () => {
  it('finds children of a crate root beside it', () => {
    expect(moduleFileCandidates(decl({ file: 'src/lib.rs', modRs: true }))).toEqual([
      'src/foo.rs',
      'src/foo/mod.rs',
    ]);
  });

  it('finds children of a repository-root file beside it', () => {
    expect(moduleFileCandidates(decl({ file: 'lib.rs', modRs: true }))).toEqual([
      'foo.rs',
      'foo/mod.rs',
    ]);
  });

  it('finds children of a mod.rs file in its own directory', () => {
    expect(moduleFileCandidates(decl({ file: 'src/a/mod.rs', modRs: true, name: 'b' }))).toEqual([
      'src/a/b.rs',
      'src/a/b/mod.rs',
    ]);
  });

  it('finds children of a non-mod-rs file in a directory named after it', () => {
    expect(moduleFileCandidates(decl({ file: 'src/a.rs', name: 'b' }))).toEqual([
      'src/a/b.rs',
      'src/a/b/mod.rs',
    ]);
  });

  it('adds inline module names as directories in a mod-rs file', () => {
    expect(
      moduleFileCandidates(
        decl({ file: 'src/lib.rs', modRs: true, inlineModules: [inline('outer')] }),
      ),
    ).toEqual(['src/outer/foo.rs', 'src/outer/foo/mod.rs']);
  });

  it('adds inline module names after the stem in a non-mod-rs file', () => {
    expect(
      moduleFileCandidates(decl({ file: 'src/a.rs', inlineModules: [inline('outer')] })),
    ).toEqual(['src/a/outer/foo.rs', 'src/a/outer/foo/mod.rs']);
  });

  it('nests inline module names in order', () => {
    expect(
      moduleFileCandidates(
        decl({ file: 'src/lib.rs', modRs: true, inlineModules: [inline('outer'), inline('mid')] }),
      ),
    ).toEqual(['src/outer/mid/foo.rs', 'src/outer/mid/foo/mod.rs']);
  });

  it('resolves #[path] relative to the declaring file outside inline modules', () => {
    expect(moduleFileCandidates(decl({ file: 'src/a.rs', pathAttr: 'x/y.rs' }))).toEqual([
      'src/x/y.rs',
    ]);
  });

  it('matches the Rust Reference table for #[path] outside inline modules', () => {
    const declaration = decl({ file: 'src/a/b.rs', pathAttr: 'foo.rs', name: 'c' });
    expect(moduleFileCandidates(declaration)).toEqual(['src/a/foo.rs']);
    const inMod = decl({ file: 'src/a/mod.rs', modRs: true, pathAttr: 'foo.rs', name: 'c' });
    expect(moduleFileCandidates(inMod)).toEqual(['src/a/foo.rs']);
  });

  it('accepts backslashes in #[path]', () => {
    expect(
      moduleFileCandidates(decl({ file: 'src/lib.rs', modRs: true, pathAttr: 'x\\y.rs' })),
    ).toEqual(['src/x/y.rs']);
  });

  it('resolves #[path] inside inline modules relative to the inline directory', () => {
    expect(
      moduleFileCandidates(
        decl({
          file: 'src/lib.rs',
          modRs: true,
          inlineModules: [inline('outer')],
          pathAttr: 'gen.rs',
        }),
      ),
    ).toEqual(['src/outer/gen.rs']);
    expect(
      moduleFileCandidates(
        decl({ file: 'src/a.rs', inlineModules: [inline('outer')], pathAttr: 'gen.rs' }),
      ),
    ).toEqual(['src/a/outer/gen.rs']);
  });

  it('matches the Rust Reference table for #[path] inside an inline module', () => {
    const innerDecl = (file: string, modRs: boolean): ModDeclaration =>
      decl({ file, modRs, inlineModules: [inline('inline')], pathAttr: 'other.rs', name: 'inner' });
    expect(moduleFileCandidates(innerDecl('src/a/b.rs', false))).toEqual([
      'src/a/b/inline/other.rs',
    ]);
    expect(moduleFileCandidates(innerDecl('src/a/mod.rs', true))).toEqual([
      'src/a/inline/other.rs',
    ]);
  });

  it('resolves #[path] on an inline module relative to the source file directory', () => {
    const declaration = decl({
      file: 'src/lib.rs',
      modRs: true,
      inlineModules: [inline('thread', 'thread_files')],
      pathAttr: 'tls.rs',
      name: 'local_data',
    });
    expect(moduleFileCandidates(declaration)).toEqual(['src/thread_files/tls.rs']);
  });

  it('places children of a #[path] inline module in its directory', () => {
    const declaration = decl({
      file: 'src/lib.rs',
      modRs: true,
      inlineModules: [inline('thread', 'thread_files')],
      name: 'x',
    });
    expect(moduleFileCandidates(declaration)).toEqual([
      'src/thread_files/x.rs',
      'src/thread_files/x/mod.rs',
    ]);
  });

  it('normalizes .. segments in #[path]', () => {
    expect(
      moduleFileCandidates(decl({ file: 'src/a/mod.rs', modRs: true, pathAttr: '../shared.rs' })),
    ).toEqual(['src/shared.rs']);
  });

  it('yields no candidates for an absolute #[path]', () => {
    expect(moduleFileCandidates(decl({ file: 'src/lib.rs', pathAttr: '/etc/x.rs' }))).toEqual([]);
    expect(
      moduleFileCandidates(
        decl({ file: 'src/lib.rs', modRs: true, inlineModules: [inline('outer', '/abs')] }),
      ),
    ).toEqual([]);
  });
});
