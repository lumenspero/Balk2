import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConnectionGraph } from '../../cli/build-graph.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const META = { generatedAt: '2026-01-01T00:00:00Z' };

function repoWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-unresolved-binding-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

/** The unresolved-binding observations in a repository, by subject and the file they are in. */
function unresolvedBindings(root: string): { subject: string; file: string }[] {
  const map = buildConnectionGraph(root).build(META);
  return Object.values(map.unresolved)
    .filter((node) => node.reason === 'unresolved-binding')
    .map((node) => ({ subject: node.subject, file: node.location.filePath }))
    .sort((a, b) => a.subject.localeCompare(b.subject));
}

const CARGO_WITH_WASM = `[package]
name = "core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
wasm-bindgen = "0.2"
`;

const CARGO_WITHOUT_WASM = `[package]
name = "core"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
`;

const RUST_EXPORTS = `use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn search(query: &str) -> String {
    query.to_string()
}
`;

const PLAIN_EXPORTS = `pub fn search(query: &str) -> String {
    query.to_string()
}
`;

describe('unresolved bindings (Phase 14.6)', () => {
  it('a JS import of a name the wasm-bindgen module does not export is an unresolved-binding', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITH_WASM,
      'src/lib.rs': RUST_EXPORTS,
      'app/index.js': `import { search, missing } from '../pkg/core.js';\n\nexport function run(q) {\n  return search(q) + missing(q);\n}\n`,
    });
    expect(unresolvedBindings(root)).toEqual([
      { subject: 'pkg/core.js:missing', file: 'app/index.js' },
    ]);
  });

  it('a JS import of a module with no binding producer writes nothing', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITHOUT_WASM,
      'src/lib.rs': PLAIN_EXPORTS,
      'app/index.js': `import { search } from '../pkg/core.js';\n\nexport function run(q) {\n  return search(q);\n}\n`,
    });
    expect(unresolvedBindings(root)).toEqual([]);
  });

  it('a Python import of a name a #[pymodule] does not register is an unresolved-binding', () => {
    const root = repoWith({
      'Cargo.toml': `[package]\nname = "fastpath"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\ncrate-type = ["cdylib"]\n\n[dependencies]\npyo3 = "0.22"\n`,
      'src/lib.rs': `use pyo3::prelude::*;\n\n#[pyfunction]\nfn parse(text: &str) -> usize {\n    text.len()\n}\n\n#[pymodule]\nfn _fastpath(m: &Bound<'_, PyModule>) -> PyResult<()> {\n    m.add_function(wrap_pyfunction!(parse, m)?)?;\n    Ok(())\n}\n`,
      'pyproject.toml': `[build-system]\nrequires = ["maturin>=1,<2"]\nbuild-backend = "maturin"\n\n[tool.maturin]\nmodule-name = "app._fastpath"\n`,
      'scripts/run.py': `from app._fastpath import parse, missing\n\nprint(parse("x"), missing)\n`,
    });
    expect(unresolvedBindings(root)).toEqual([
      { subject: 'app._fastpath:missing', file: 'scripts/run.py' },
    ]);
  });
});
