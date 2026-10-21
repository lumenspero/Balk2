import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inventoryOf, type FileInventory } from './oracle-inventory.js';

/**
 * The CPython oracle (V3 Phase 3.4). It runs only in the python-oracle CI job, which sets
 * BALK2_PY_ORACLE_INVENTORY to the output of test/python-oracle/dump_inventory.py and
 * BALK2_PY_ORACLE_ROOT to the directory that output describes.
 */
const inventoryPath = process.env.BALK2_PY_ORACLE_INVENTORY;
const root = process.env.BALK2_PY_ORACLE_ROOT ?? '';
const expected: Record<string, FileInventory> | undefined =
  inventoryPath === undefined
    ? undefined
    : (JSON.parse(readFileSync(inventoryPath, 'utf8')) as Record<string, FileInventory>);

describe('python oracle: Balk2 matches CPython ast', () => {
  if (expected === undefined) {
    it.skip('runs only in the python-oracle CI job', () => undefined);
    return;
  }
  for (const [file, want] of Object.entries(expected)) {
    it(file, () => {
      const source = readFileSync(join(root, file));
      expect(inventoryOf(source.toString('utf8'))).toEqual(want);
    });
  }
});
