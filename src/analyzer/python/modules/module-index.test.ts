import { describe, expect, it } from 'vitest';
import { ModuleIndex } from './module-index.js';

describe('ModuleIndex lookups', () => {
  it('lets a regular package beat a module of the same name, and reports the hidden module', () => {
    const index = new ModuleIndex(['pkg/x/__init__.py', 'pkg/x.py']);
    const lookup = index.resolve(['pkg', 'x'], ['.']);
    expect(lookup.entry).toMatchObject({
      kind: 'package',
      dir: 'pkg/x',
      init: 'pkg/x/__init__.py',
    });
    expect(lookup.shadowed).toEqual([{ module: 'pkg/x.py', package: 'pkg/x' }]);
  });

  it('prefers a .py module over its .pyi stub, and uses a stub when it is alone', () => {
    const index = new ModuleIndex(['both.py', 'both.pyi', 'stubby.pyi']);
    expect(index.resolve(['both'], ['.']).entry).toMatchObject({
      kind: 'module',
      file: 'both.py',
      stubOnly: false,
    });
    expect(index.resolve(['stubby'], ['.']).entry).toMatchObject({
      kind: 'module',
      file: 'stubby.pyi',
      stubOnly: true,
    });
  });

  it('gathers namespace portions across roots (PEP 420)', () => {
    const index = new ModuleIndex(['a/ns/one.py', 'b/ns/two.py']);
    const lookup = index.resolve(['ns'], ['a', 'b']);
    expect(lookup.entry).toEqual({ kind: 'namespace', name: 'ns', dirs: ['a/ns', 'b/ns'] });
  });

  it('uses a regular package in a later root over a namespace in an earlier root', () => {
    const index = new ModuleIndex(['a/pk/one.py', 'b/pk/__init__.py']);
    expect(index.resolve(['pk'], ['a', 'b']).entry).toMatchObject({ kind: 'package', dir: 'b/pk' });
  });

  it('uses a module in a later root over a namespace in an earlier root', () => {
    const index = new ModuleIndex(['a/m/z.py', 'b/m.py']);
    expect(index.resolve(['m'], ['a', 'b']).entry).toMatchObject({
      kind: 'module',
      file: 'b/m.py',
    });
  });

  it('searches a segment only inside its parent, so a module has no children', () => {
    const index = new ModuleIndex(['mod.py', 'mod/child.py']);
    const lookup = index.resolve(['mod', 'child'], ['.']);
    expect(lookup.entry).toBeUndefined();
    expect(lookup.missingAt).toBe(1);
    expect(lookup.chain).toHaveLength(1);
  });
});
