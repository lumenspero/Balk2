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
    expect(validate({ version: 3, rust: { bindings: [] } })).toBe(false);
  });
});
