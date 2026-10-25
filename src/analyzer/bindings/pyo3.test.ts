import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildConnectionGraph } from '../../cli/build-graph.js';
import type { ConnectionGraph } from '../../graph.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function repoWith(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-pyo3-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return root;
}

const CARGO_WITH_PYO3 = `[package]
name = "fastpath"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
pyo3 = "0.22"
`;

const CARGO_WITHOUT_PYO3 = `[package]
name = "fastpath"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
`;

/** A PyO3 module named by its function, with a pyfunction and a pyclass registered in its body. */
const RUST_MODULE = `use pyo3::prelude::*;

#[pyfunction]
fn parse(text: &str) -> usize {
    text.len()
}

#[pyclass]
struct Index {
    size: usize,
}

#[pymodule]
fn _fastpath(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(parse, m)?)?;
    m.add_class::<Index>()?;
    Ok(())
}
`;

const PYTHON_IMPORTS = `from _fastpath import parse, Index

print(parse("x"), Index)
`;

const MATURIN_PYPROJECT = `[build-system]
requires = ["maturin>=1,<2"]
build-backend = "maturin"

[tool.maturin]
module-name = "app._fastpath"
`;

function pyo3Edges(graph: ConnectionGraph): ReturnType<ConnectionGraph['getRelationships']> {
  return graph
    .getRelationships()
    .filter((r) => (r.metadata as Record<string, unknown> | undefined)?.mechanism === 'pyo3');
}

describe('PyO3: Python imports of a #[pymodule]', () => {
  it('writes a calls edge from the Python file to each registered function and class', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITH_PYO3,
      'src/lib.rs': RUST_MODULE,
      'scripts/run.py': PYTHON_IMPORTS,
    });
    const edges = pyo3Edges(buildConnectionGraph(root));
    expect(edges.map((e) => [e.type, e.from, e.to, e.confidence])).toEqual([
      ['calls', 'scripts/run.py', 'src/lib.rs:Index', 'medium'],
      ['calls', 'scripts/run.py', 'src/lib.rs:parse', 'medium'],
    ]);
  });

  it('names the module from [tool.maturin] module-name when it is set, with high confidence', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITH_PYO3,
      'pyproject.toml': MATURIN_PYPROJECT,
      'src/lib.rs': RUST_MODULE,
      'scripts/run.py': `from app._fastpath import parse\n\nprint(parse("x"))\n`,
    });
    const edges = pyo3Edges(buildConnectionGraph(root));
    expect(edges.map((e) => [e.from, e.to, e.confidence])).toEqual([
      ['scripts/run.py', 'src/lib.rs:parse', 'high'],
    ]);
  });
});

describe('PyO3: negatives', () => {
  it('writes no edge when the crate does not depend on pyo3', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITHOUT_PYO3,
      'src/lib.rs': RUST_MODULE,
      'scripts/run.py': PYTHON_IMPORTS,
    });
    expect(pyo3Edges(buildConnectionGraph(root))).toHaveLength(0);
  });

  it('writes no edge for a name the module does not register', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITH_PYO3,
      'src/lib.rs': RUST_MODULE,
      'scripts/run.py': `from _fastpath import unregistered\n`,
    });
    expect(pyo3Edges(buildConnectionGraph(root))).toHaveLength(0);
  });

  it('writes no edge for a module of a different name', () => {
    const root = repoWith({
      'Cargo.toml': CARGO_WITH_PYO3,
      'src/lib.rs': RUST_MODULE,
      'scripts/run.py': `from elsewhere import parse\n`,
    });
    expect(pyo3Edges(buildConnectionGraph(root))).toHaveLength(0);
  });
});
