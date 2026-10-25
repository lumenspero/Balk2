import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildConnectionGraph } from '../../../cli/build-graph.js';
import type { ConnectionMap } from '../../../types.js';

let root: string;

function write(relPath: string, content: string): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function build(): ConnectionMap {
  return buildConnectionGraph(root).build({ generatedAt: '2026-01-01T00:00:00Z' });
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-alias-'));
  // An umbrella crate that re-exports a sibling library under a short alias, as ripgrep's `grep` does.
  write(
    'crates/grep/Cargo.toml',
    '[package]\nname = "grep"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  write('crates/grep/src/lib.rs', 'pub extern crate inner_lib as inner;\n');
  write(
    'crates/inner/Cargo.toml',
    '[package]\nname = "inner-lib"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  write('crates/inner/src/lib.rs', 'pub fn go() {}\n');
  write('crates/app/Cargo.toml', '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n');
  write('crates/app/src/main.rs', 'use grep::inner::go;\n\nfn main() {\n    go();\n}\n');
  // A proc-macro package consumed by an integration test, as async-trait is.
  write(
    'macros/Cargo.toml',
    '[package]\nname = "my-mac"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\nproc-macro = true\n',
  );
  write(
    'macros/src/lib.rs',
    '#[proc_macro_attribute]\npub fn my_attr(args: TokenStream, input: TokenStream) -> TokenStream {\n    input\n}\n',
  );
  write('macros/tests/t.rs', 'use my_mac::my_attr;\n\n#[my_attr]\nfn f() {}\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('extern crate aliases and proc-macro packages in Rust paths', () => {
  it('resolves a path through an extern crate alias at a repository crate root', () => {
    const map = build();
    const unresolved = Object.values(map.unresolved).filter(
      (u) => u.reason === 'unresolved-module-path',
    );
    expect(unresolved).toEqual([]);
    const targets = map.relationships
      .filter((r) => r.type === 'imports' && r.from === 'crates/app/src/main.rs')
      .map((r) => r.to);
    expect(targets.some((t) => t.startsWith('crates/inner/src/lib.rs'))).toBe(true);
  });

  it('resolves a use of a proc-macro package from an integration test', () => {
    const map = build();
    const targets = map.relationships
      .filter((r) => r.type === 'imports' && r.from === 'macros/tests/t.rs')
      .map((r) => r.to);
    expect(targets).toEqual(['macros/src/lib.rs']);
  });
});
