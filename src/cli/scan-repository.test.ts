import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanRepositoryFiles } from './build-graph.js';

let root: string;

function write(relPath: string, content = ''): void {
  const full = path.join(root, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-scan-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('scanRepositoryFiles exclusions (V3 Phase 1.3)', () => {
  it('excludes target/ only beside a Cargo.toml', () => {
    write('crates/ingest/Cargo.toml', '[package]\n');
    write('crates/ingest/src/main.rs', 'fn main() {}\n');
    write('crates/ingest/target/debug/build.d', 'x');
    write('tools/target/keep.txt', 'kept: no Cargo.toml beside it');

    expect(scanRepositoryFiles(root)).toEqual([
      'crates/ingest/Cargo.toml',
      'crates/ingest/src/main.rs',
      'tools/target/keep.txt',
    ]);
  });

  it('excludes .venv and venv only when they contain pyvenv.cfg', () => {
    write('.venv/pyvenv.cfg', 'home = /usr/bin\n');
    write('.venv/lib/site.py', 'x');
    write('tools/venv/notes.txt', 'kept: no pyvenv.cfg');
    write('app/main.py', 'print(1)\n');

    expect(scanRepositoryFiles(root)).toEqual(['app/main.py', 'tools/venv/notes.txt']);
  });

  it('excludes Python caches and egg-info directories by name', () => {
    write('pkg/__pycache__/mod.cpython-312.pyc', 'x');
    write('.pytest_cache/v/cache/nodeids', 'x');
    write('.mypy_cache/3.12/mod.json', 'x');
    write('.ruff_cache/CACHEDIR.TAG', 'x');
    write('.tox/py312/log.txt', 'x');
    write('pkg.egg-info/PKG-INFO', 'x');
    write('pkg/mod.py', 'x = 1\n');

    expect(scanRepositoryFiles(root)).toEqual(['pkg/mod.py']);
  });

  it('excludes dependency lock files and keeps manifests', () => {
    for (const lock of [
      'Cargo.lock',
      'poetry.lock',
      'uv.lock',
      'pdm.lock',
      'package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
    ]) {
      write(lock, 'lock');
    }
    write('Cargo.toml', '[package]\n');
    write('pyproject.toml', '[project]\n');
    write('package.json', '{}\n');

    expect(scanRepositoryFiles(root)).toEqual(['Cargo.toml', 'package.json', 'pyproject.toml']);
  });

  it('keeps the existing default exclusions', () => {
    write('node_modules/x/index.js', 'x');
    write('dist/index.js', 'x');
    write('src/index.ts', 'x');

    expect(scanRepositoryFiles(root)).toEqual(['src/index.ts']);
  });
});

describe('scanRepositoryFiles symbolic links', () => {
  it('includes a symbolic link to a file and does not follow a link to a directory', () => {
    write('shared/util.ts', 'export const u = 1;\n');
    write('src/real.ts', 'export {};\n');
    fs.symlinkSync(path.join(root, 'shared/util.ts'), path.join(root, 'src/util.ts'));
    fs.symlinkSync(path.join(root, 'shared'), path.join(root, 'src/shared-dir'));

    expect(scanRepositoryFiles(root)).toEqual(['shared/util.ts', 'src/real.ts', 'src/util.ts']);
  });
});
