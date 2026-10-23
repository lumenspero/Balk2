import { describe, expect, it } from 'vitest';
import { bindProcMacros, type ProcMacroCrate, type ProcMacroEdge } from './proc-macros.js';
import { buildCrateIndex } from './module-index.js';

const DERIVE_ID = 'package:cargo:crates/derive#proc-macro:my-derive';
const APP_ID = 'package:cargo:crates/app#lib:app';
const OTHER_ID = 'package:cargo:crates/other#proc-macro:other-derive';

function crateOf(id: string, root: string, files: Record<string, string>, procMacro: boolean): ProcMacroCrate {
  return {
    id,
    procMacro,
    index: buildCrateIndex({
      root,
      files: new Set(Object.keys(files)),
      readText: (file) => files[file] ?? '',
      edition: '2021',
    }),
  };
}

/** Each edge as [from, to, mechanism]. */
function edgesOf(edges: readonly ProcMacroEdge[]): [string, string, string][] {
  return edges.map((edge) => [edge.from, edge.to, edge.mechanism]);
}

const DERIVE_LIB =
  '#[proc_macro_derive(Describe, attributes(describe))]\npub fn describe(input: TokenStream) -> TokenStream { input }\n' +
  '#[proc_macro_attribute]\npub fn route(attr: TokenStream, item: TokenStream) -> TokenStream { item }\n' +
  '#[proc_macro]\npub fn make(input: TokenStream) -> TokenStream { input }\n';

const DERIVE_FILES = { 'crates/derive/src/lib.rs': DERIVE_LIB };

describe('bindProcMacros: derives (V3 Phase 10.3)', () => {
  it('links a derive on a struct to the proc-macro function that provides it', () => {
    const edges = bindProcMacros(
      [
        crateOf(DERIVE_ID, 'crates/derive/src/lib.rs', DERIVE_FILES, true),
        crateOf(APP_ID, 'crates/app/src/lib.rs', {
          'crates/app/src/lib.rs': '#[derive(Debug, Describe)]\npub struct Point;\n',
        }, false),
      ],
      [{ from: APP_ID, to: DERIVE_ID }],
    );
    expect(edgesOf(edges)).toEqual([
      ['crates/app/src/lib.rs:Point', 'crates/derive/src/lib.rs:describe', 'derive'],
    ]);
  });

  it('accepts a qualified derive path and keeps the last segment', () => {
    const edges = bindProcMacros(
      [
        crateOf(DERIVE_ID, 'crates/derive/src/lib.rs', DERIVE_FILES, true),
        crateOf(APP_ID, 'crates/app/src/lib.rs', {
          'crates/app/src/lib.rs': '#[derive(my_derive::Describe)]\nenum Mode { A }\n',
        }, false),
      ],
      [{ from: APP_ID, to: DERIVE_ID }],
    );
    expect(edgesOf(edges)).toEqual([
      ['crates/app/src/lib.rs:Mode', 'crates/derive/src/lib.rs:describe', 'derive'],
    ]);
  });

  it('draws no edge when the consumer does not depend on the proc-macro crate', () => {
    const edges = bindProcMacros(
      [
        crateOf(DERIVE_ID, 'crates/derive/src/lib.rs', DERIVE_FILES, true),
        crateOf(APP_ID, 'crates/app/src/lib.rs', {
          'crates/app/src/lib.rs': '#[derive(Describe)]\npub struct Point;\n',
        }, false),
      ],
      [],
    );
    expect(edges).toEqual([]);
  });

  it('draws no edge for a derive that no dependency provides, such as a std derive', () => {
    const edges = bindProcMacros(
      [
        crateOf(DERIVE_ID, 'crates/derive/src/lib.rs', DERIVE_FILES, true),
        crateOf(APP_ID, 'crates/app/src/lib.rs', {
          'crates/app/src/lib.rs': '#[derive(Debug)]\npub struct Point;\n',
        }, false),
      ],
      [{ from: APP_ID, to: DERIVE_ID }],
    );
    expect(edges).toEqual([]);
  });

  it('draws no edge when two proc-macro dependencies provide the same derive name', () => {
    const edges = bindProcMacros(
      [
        crateOf(DERIVE_ID, 'crates/derive/src/lib.rs', DERIVE_FILES, true),
        crateOf(OTHER_ID, 'crates/other/src/lib.rs', {
          'crates/other/src/lib.rs':
            '#[proc_macro_derive(Describe)]\npub fn other(input: TokenStream) -> TokenStream { input }\n',
        }, true),
        crateOf(APP_ID, 'crates/app/src/lib.rs', {
          'crates/app/src/lib.rs': '#[derive(Describe)]\npub struct Point;\n',
        }, false),
      ],
      [
        { from: APP_ID, to: DERIVE_ID },
        { from: APP_ID, to: OTHER_ID },
      ],
    );
    expect(edges).toEqual([]);
  });
});

describe('bindProcMacros: attributes (V3 Phase 10.3)', () => {
  it('links an attribute on a function to the attribute proc macro that provides it', () => {
    const edges = bindProcMacros(
      [
        crateOf(DERIVE_ID, 'crates/derive/src/lib.rs', DERIVE_FILES, true),
        crateOf(APP_ID, 'crates/app/src/lib.rs', {
          'crates/app/src/lib.rs': '#[route(get)]\npub fn handler() {}\n',
        }, false),
      ],
      [{ from: APP_ID, to: DERIVE_ID }],
    );
    expect(edgesOf(edges)).toEqual([
      ['crates/app/src/lib.rs:handler', 'crates/derive/src/lib.rs:route', 'attribute'],
    ]);
  });

  it('does not match a function-like #[proc_macro] as an attribute', () => {
    const edges = bindProcMacros(
      [
        crateOf(DERIVE_ID, 'crates/derive/src/lib.rs', DERIVE_FILES, true),
        crateOf(APP_ID, 'crates/app/src/lib.rs', {
          'crates/app/src/lib.rs': '#[make]\npub fn handler() {}\n',
        }, false),
      ],
      [{ from: APP_ID, to: DERIVE_ID }],
    );
    expect(edges).toEqual([]);
  });

  it('ignores a proc macro in a crate that is not a proc-macro crate', () => {
    const edges = bindProcMacros(
      [
        crateOf(DERIVE_ID, 'crates/derive/src/lib.rs', DERIVE_FILES, false),
        crateOf(APP_ID, 'crates/app/src/lib.rs', {
          'crates/app/src/lib.rs': '#[route(get)]\npub fn handler() {}\n',
        }, false),
      ],
      [{ from: APP_ID, to: DERIVE_ID }],
    );
    expect(edges).toEqual([]);
  });
});
