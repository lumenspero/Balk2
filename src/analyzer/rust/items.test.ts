import { describe, expect, it } from 'vitest';
import { parseRustFile, type Item, type UseTree } from './items.js';

const parse = (source: string): Item[] => parseRustFile(source).items.slice();

describe('rust items: attributes', () => {
  it('reads outer and inner attributes with their path and arguments', () => {
    const file = parseRustFile('#![allow(dead_code)]\n#[derive(Debug, Clone)]\npub struct S;\n');
    expect(file.errors).toEqual([]);
    expect(file.innerAttrs).toMatchObject([{ inner: true, path: 'allow', raw: '(dead_code)' }]);
    const [item] = file.items;
    expect(item?.attrs).toMatchObject([{ inner: false, path: 'derive', raw: '(Debug , Clone)' }]);
  });

  it('joins a multi-segment attribute path', () => {
    const [item] = parse('#[rustfmt::skip]\nuse a;\n');
    expect(item?.attrs).toMatchObject([{ path: 'rustfmt::skip', raw: '' }]);
  });

  it('reports a hash that is not followed by brackets', () => {
    const file = parseRustFile('# use a;\n');
    expect(file.errors.map((e) => e.message)).toContain('expected `[` after `#`');
  });
});

describe('rust items: visibility', () => {
  it('reads every visibility form', () => {
    const items = parse(
      'use a;\npub use b;\npub(crate) use c;\npub(super) use d;\npub(self) use e;\npub(in crate::m) use f;\n',
    );
    expect(items.map((i) => i.vis)).toEqual([
      { kind: 'private' },
      { kind: 'public' },
      { kind: 'restricted', scope: 'crate', path: [] },
      { kind: 'restricted', scope: 'super', path: [] },
      { kind: 'restricted', scope: 'self', path: [] },
      { kind: 'restricted', scope: 'in', path: ['crate', 'm'] },
    ]);
  });
});

describe('rust items: use trees', () => {
  const useTreeOf = (source: string): UseTree | null | undefined => {
    const [item] = parse(source);
    return item?.kind === 'use' ? item.tree : undefined;
  };

  it('expands nested groups, self, globs, renames and underscore aliases', () => {
    expect(useTreeOf('use std::{self, fmt::{self, Display as D}, io::*, x as _};')).toEqual({
      kind: 'nested',
      path: ['std'],
      items: [
        { kind: 'name', path: ['std', 'self'], alias: null },
        {
          kind: 'nested',
          path: ['std', 'fmt'],
          items: [
            { kind: 'name', path: ['std', 'fmt', 'self'], alias: null },
            { kind: 'name', path: ['std', 'fmt', 'Display'], alias: 'D' },
          ],
        },
        { kind: 'glob', path: ['std', 'io'] },
        { kind: 'name', path: ['std', 'x'], alias: '_' },
      ],
    });
  });

  it('accepts a leading `::` and a plain path', () => {
    expect(useTreeOf('use ::core::fmt;')).toEqual({
      kind: 'name',
      path: ['core', 'fmt'],
      alias: null,
    });
  });

  it('reads a crate-relative glob', () => {
    expect(useTreeOf('pub(crate) use super::*;')).toEqual({ kind: 'glob', path: ['super'] });
  });

  it('reports a trailing `::` and a missing `;`', () => {
    const file = parseRustFile('use a::;');
    const messages = file.errors.map((e) => e.message);
    expect(messages).toContain('expected a path segment in use declaration');
  });

  it('reports a use declaration without `;`', () => {
    const file = parseRustFile('use a\nuse b;\n');
    expect(file.errors.map((e) => e.message)).toEqual(['expected `;` after use declaration']);
    expect(file.items.map((i) => i.kind)).toEqual(['use', 'use']);
  });
});

describe('rust items: modules', () => {
  it('reads an external module declaration', () => {
    const [item] = parse('mod parser;');
    expect(item).toMatchObject({ kind: 'mod', name: 'parser', inline: false, items: [] });
  });

  it('reads an inline module and its items in order', () => {
    const [item] = parse('mod b { fn f() {} use x; }');
    expect(item).toMatchObject({ kind: 'mod', name: 'b', inline: true });
    if (item?.kind !== 'mod') throw new Error('expected a module');
    expect(item.items.map((i) => i.kind)).toEqual(['fn', 'use']);
    expect(item.items[0]).toMatchObject({ kind: 'fn', name: 'f' });
  });

  it('reads inner attributes of an inline module', () => {
    const [item] = parse('mod b { #![allow(unused)] use x; }');
    if (item?.kind !== 'mod') throw new Error('expected a module');
    expect(item.innerAttrs).toMatchObject([{ inner: true, path: 'allow' }]);
    expect(item.items.map((i) => i.kind)).toEqual(['use']);
  });

  it('reports a module without a name', () => {
    const file = parseRustFile('mod ;\nuse a;\n');
    expect(file.errors.map((e) => e.message)).toEqual(['expected a module name']);
    expect(file.items.map((i) => i.kind)).toEqual(['unknown', 'use']);
  });

  it('reports a module with neither `;` nor a body', () => {
    const file = parseRustFile('mod a use b;');
    expect(file.errors.map((e) => e.message)).toEqual(['expected `;` or `{` after module name']);
  });
});

describe('rust items: unknown forms and spans', () => {
  it('keeps unparsed forms as unknown items without an error', () => {
    const file = parseRustFile('impl X {}\ntrait T {}\nextern crate foo;\n');
    expect(file.errors).toEqual([]);
    expect(file.items.map((i) => (i.kind === 'unknown' ? i.keyword : i.kind))).toEqual([
      'impl',
      'trait',
      'extern',
    ]);
  });

  it('reports a stray semicolon at item level', () => {
    const file = parseRustFile('use a;;\n');
    expect(file.errors.map((e) => e.message)).toEqual(['expected item, found `;`']);
  });

  it('spans an item from its first attribute to its last token', () => {
    const [item] = parse('pub use a;');
    expect(item?.span).toEqual({ line: 1, column: 1, endLine: 1, endColumn: 11 });
  });

  it('merges problems from every stage into source order', () => {
    const file = parseRustFile('mod a {\n  use b\n');
    expect(file.errors.map((e) => [e.line, e.message])).toEqual([
      [1, 'unclosed `{`'],
      [2, 'expected `;` after use declaration'],
    ]);
  });

  it('parses a file with no items', () => {
    expect(parseRustFile('')).toEqual({ innerAttrs: [], items: [], errors: [] });
  });
});
