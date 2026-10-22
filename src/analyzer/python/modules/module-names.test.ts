import { describe, expect, it } from 'vitest';
import { moduleNames } from './module-names.js';

describe('moduleNames', () => {
  it('collects top-level bindings and descends into blocks, but not into functions', () => {
    const names = moduleNames(
      [
        'import os.path',
        'import json as j',
        'from x import y as z',
        'a, (b, *c) = 1, (2, [3])',
        'def f():',
        '    inner = 1',
        'class K:',
        '    attr = 2',
        'if True:',
        '    d = 4',
        'try:',
        '    e = 5',
        'except ValueError as err:',
        '    pass',
        'for i in range(3):',
        '    pass',
      ].join('\n'),
    );
    expect(names.bound).toEqual(['os', 'j', 'z', 'a', 'b', 'c', 'f', 'K', 'd', 'e', 'err', 'i']);
    expect(names.all).toBeUndefined();
  });

  it('reads a static __all__ list or tuple, and extends it with +=', () => {
    expect(moduleNames('__all__ = ["a", \'b\']').all).toEqual(['a', 'b']);
    expect(moduleNames('__all__ = ("a",)\n__all__ += ["c"]').all).toEqual(['a', 'c']);
  });

  it('reports a dynamic __all__ as not static', () => {
    expect(moduleNames('__all__ = [n for n in dir()]').all).toBeUndefined();
    expect(moduleNames('__all__ = ["a"]\n__all__ = build()').all).toBeUndefined();
    expect(moduleNames('__all__ = ["a" "b"]').all).toBeUndefined();
  });
});
