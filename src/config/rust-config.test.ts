import { describe, expect, it } from 'vitest';
import type { ConfigProblem } from './config-problem.js';
import { normalizeRustConfig } from './rust-config.js';
import { loadBalk2ConfigDetailed } from './balk2-config.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function normalize(value: unknown): {
  config: ReturnType<typeof normalizeRustConfig>;
  problems: ConfigProblem[];
} {
  const problems: ConfigProblem[] = [];
  return { config: normalizeRustConfig(value, problems), problems };
}

describe('rust.macros.expressionLike', () => {
  it('keeps a list of macro names, without duplicates', () => {
    const { config, problems } = normalize({
      macros: { expressionLike: ['log_info', 'log_info', 'trace'] },
    });
    expect(config).toEqual({ macros: { expressionLike: ['log_info', 'trace'] } });
    expect(problems).toEqual([]);
  });

  it('reports a name with "!" or a dash and keeps the valid names', () => {
    const { config, problems } = normalize({
      macros: { expressionLike: ['log_info!', 'trace', 'bad-name'] },
    });
    expect(config).toEqual({ macros: { expressionLike: ['trace'] } });
    expect(problems.map((p) => p.path)).toEqual([
      'rust.macros.expressionLike[0]',
      'rust.macros.expressionLike[2]',
    ]);
  });

  it('reports a value that is not a list', () => {
    const { config, problems } = normalize({ macros: { expressionLike: 'log_info' } });
    expect(config).toEqual({});
    expect(problems).toEqual([
      { path: 'rust.macros.expressionLike', message: 'must be an array of macro names' },
    ]);
  });

  it('reports an unknown key under rust and under macros, and ignores them', () => {
    const { problems } = normalize({ macros: { expressionLike: [], other: 1 }, nope: [] });
    expect(problems).toContainEqual({ path: 'rust.macros.other', message: 'unknown key ignored' });
    expect(problems).toContainEqual({ path: 'rust.nope', message: 'unknown key ignored' });
  });

  it('reports a section that is not an object', () => {
    expect(normalize([]).problems).toEqual([{ path: 'rust', message: 'must be an object' }]);
  });

  it('is read by the loader from .balk2.json, without problems for a valid file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-rust-config-'));
    try {
      fs.writeFileSync(
        path.join(dir, '.balk2.json'),
        JSON.stringify({ version: 3, rust: { macros: { expressionLike: ['log_info'] } } }),
      );
      const loaded = loadBalk2ConfigDetailed(dir);
      expect(loaded.problems).toEqual([]);
      expect(loaded.config?.rust?.macros?.expressionLike).toEqual(['log_info']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rust.bindings', () => {
  it('keeps each entry with the override its kind accepts', () => {
    const { config, problems } = normalize({
      bindings: [
        { kind: 'wasm-bindgen', crate: 'core', outDir: './web/pkg/' },
        { kind: 'napi', crate: 'native', packageName: '@scope/native' },
        { kind: 'pyo3', crate: 'fastpath', pythonModule: 'app.native' },
        { kind: 'pyo3', crate: 'plain' },
      ],
    });
    expect(config).toEqual({
      bindings: [
        { kind: 'wasm-bindgen', crate: 'core', outDir: 'web/pkg' },
        { kind: 'napi', crate: 'native', packageName: '@scope/native' },
        { kind: 'pyo3', crate: 'fastpath', pythonModule: 'app.native' },
        { kind: 'pyo3', crate: 'plain' },
      ],
    });
    expect(problems).toEqual([]);
  });

  it('reports an unknown kind, a bad crate name, and a key the kind does not use, then keeps the rest', () => {
    const { config, problems } = normalize({
      bindings: [
        { kind: 'cgo', crate: 'x' },
        { kind: 'pyo3', crate: 'bad name' },
        { kind: 'napi', crate: 'n', pythonModule: 'x' },
        { kind: 'pyo3', crate: 'ok', pythonModule: 'ok' },
      ],
    });
    // A key the kind does not use is reported and dropped; the entry itself is kept.
    expect(config).toEqual({
      bindings: [
        { kind: 'napi', crate: 'n' },
        { kind: 'pyo3', crate: 'ok', pythonModule: 'ok' },
      ],
    });
    expect(problems.map((p) => p.path)).toEqual([
      'rust.bindings[0].kind',
      'rust.bindings[1].crate',
      'rust.bindings[2].pythonModule',
    ]);
  });

  it('rejects an unsafe outDir, a bad npm package name, and a bad Python module name', () => {
    const { config, problems } = normalize({
      bindings: [
        { kind: 'wasm-bindgen', crate: 'a', outDir: '/abs' },
        { kind: 'wasm-bindgen', crate: 'b', outDir: '../escape' },
        { kind: 'napi', crate: 'c', packageName: 'Not Valid' },
        { kind: 'pyo3', crate: 'd', pythonModule: 'bad-name' },
      ],
    });
    expect(config).toEqual({ bindings: [] });
    expect(problems.map((p) => p.path)).toEqual([
      'rust.bindings[0].outDir',
      'rust.bindings[1].outDir',
      'rust.bindings[2].packageName',
      'rust.bindings[3].pythonModule',
    ]);
  });

  it('reports a value that is not an array', () => {
    expect(normalize({ bindings: {} }).problems).toEqual([
      { path: 'rust.bindings', message: 'must be an array' },
    ]);
  });
});
