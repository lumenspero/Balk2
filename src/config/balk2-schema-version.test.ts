import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const schema: object = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'schemas', 'balk2.schema.json'), 'utf8'),
) as object;
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);

describe('balk2.schema.json version', () => {
  it('accepts configuration versions 2 and 3', () => {
    expect(validate({ version: 2 })).toBe(true);
    expect(validate({ version: 3 })).toBe(true);
  });

  it('rejects any other version', () => {
    expect(validate({ version: 1 })).toBe(false);
    expect(validate({ version: 4 })).toBe(false);
  });

  it('rejects a top-level key the schema does not define', () => {
    expect(validate({ version: 3, notAKey: {} })).toBe(false);
  });

  it('accepts rust.macros.expressionLike and rejects an unknown rust key', () => {
    expect(validate({ version: 3, rust: { macros: { expressionLike: ['log_info'] } } })).toBe(true);
    expect(validate({ version: 3, rust: { macros: { expressionLike: ['log-info'] } } })).toBe(
      false,
    );
  });

  it('accepts rust.bindings entries for each kind and rejects a key the kind does not use', () => {
    expect(validate({ version: 3, rust: { bindings: [] } })).toBe(true);
    expect(
      validate({
        version: 3,
        rust: {
          bindings: [
            { kind: 'wasm-bindgen', crate: 'core', outDir: 'web/pkg' },
            { kind: 'napi', crate: 'native', packageName: '@scope/native' },
            { kind: 'pyo3', crate: 'py', pythonModule: 'my_pkg.native' },
          ],
        },
      }),
    ).toBe(true);
    expect(
      validate({
        version: 3,
        rust: { bindings: [{ kind: 'napi', crate: 'n', pythonModule: 'x' }] },
      }),
    ).toBe(false);
  });

  it('rejects an unknown binding kind, a missing crate, and an unsafe outDir', () => {
    expect(validate({ version: 3, rust: { bindings: [{ kind: 'cgo', crate: 'x' }] } })).toBe(false);
    expect(validate({ version: 3, rust: { bindings: [{ kind: 'pyo3' }] } })).toBe(false);
    expect(
      validate({
        version: 3,
        rust: { bindings: [{ kind: 'wasm-bindgen', crate: 'c', outDir: '/abs' }] },
      }),
    ).toBe(false);
    expect(
      validate({
        version: 3,
        rust: { bindings: [{ kind: 'wasm-bindgen', crate: 'c', outDir: '../x' }] },
      }),
    ).toBe(false);
  });
});
