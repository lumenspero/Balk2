import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveImportRoots } from '../project/import-roots.js';
import { discoverPythonPackages } from '../project/python-packages.js';
import { createImportResolver, type ResolvedImport } from './import-resolution.js';
import { ModuleIndex } from './module-index.js';

/**
 * The importlib oracle (V3 Phase 4.6). It runs only in the python-oracle CI job, which sets
 * BALK2_PY_RESOLUTION_ORACLE to the output of test/python-oracle/resolve_oracle.py and
 * BALK2_PY_RESOLUTION_ROOT to the directory of cases that output describes.
 */
interface OracleEntry {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  readonly kind: 'file' | 'external' | 'unresolved' | 'namespace';
  readonly path?: string;
  readonly via?: string;
  readonly names?: readonly string[];
}

interface Observed {
  readonly kind: 'file' | 'external' | 'unresolved';
  readonly path?: string;
  readonly via: string;
  readonly names?: readonly string[];
}

const dumpPath = process.env.BALK2_PY_RESOLUTION_ORACLE;
const caseRoot = process.env.BALK2_PY_RESOLUTION_ROOT ?? '';
const oracle: Record<string, OracleEntry[]> | undefined =
  dumpPath === undefined
    ? undefined
    : (JSON.parse(readFileSync(dumpPath, 'utf8')) as Record<string, OracleEntry[]>);

/** Every file under a directory, as repository-relative forward-slash paths. */
function listFiles(directory: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(directory, prefix))) {
    if (entry.startsWith('.')) continue;
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(join(directory, rel)).isDirectory()) out.push(...listFiles(directory, rel));
    else if (entry !== 'case.json') out.push(rel);
  }
  return out.sort();
}

const keyOf = (file: string, line: number, name: string): string => `${file}:${line}:${name}`;

describe('python import resolution: Balk2 matches importlib', () => {
  if (oracle === undefined) {
    it.skip('runs only in the python-oracle CI job', () => undefined);
    return;
  }
  for (const [name, entries] of Object.entries(oracle)) {
    it(name, () => {
      const directory = join(caseRoot, name);
      const config = JSON.parse(readFileSync(join(directory, 'case.json'), 'utf8')) as {
        roots: string[];
      };
      const files = listFiles(directory);
      const readText = (path: string): string => readFileSync(join(directory, path), 'utf8');
      const packages = discoverPythonPackages(files, readText).packages;
      const roots = resolveImportRoots({
        configured: config.roots,
        packages,
        filePaths: files,
      }).roots.map((root) => root.path);
      const resolver = createImportResolver(new ModuleIndex(files), { roots, readText });

      const observed = new Map<string, Observed>();
      for (const file of files.filter((path) => path.endsWith('.py'))) {
        for (const result of resolver.resolveFile(file, readText(file))) {
          record(observed, file, result);
        }
      }

      const expectedKeys = entries
        .filter((e) => e.kind !== 'namespace')
        .map((e) => keyOf(e.file, e.line, e.name));
      expect([...observed.keys()].sort()).toEqual(expectedKeys.sort());
      for (const entry of entries) {
        const key = keyOf(entry.file, entry.line, entry.name);
        if (entry.kind === 'namespace') {
          expect(observed.has(key), key).toBe(false);
          continue;
        }
        const got = observed.get(key);
        expect(got?.kind, key).toBe(entry.kind);
        if (entry.kind === 'file') {
          expect(got?.path, key).toBe(entry.path);
          expect(got?.via, key).toBe(entry.via);
        }
        if (entry.names !== undefined) {
          expect(got?.names, key).toEqual([...entry.names].sort());
        }
      }
    });
  }
});

/** Record what a resolved import observes under each bound name, or under `*` for a star import. */
function record(observed: Map<string, Observed>, file: string, result: ResolvedImport): void {
  const target = result.target;
  const kind: Observed['kind'] =
    target.kind === 'file' ? 'file' : target.kind === 'external' ? 'external' : 'unresolved';
  const path = target.kind === 'file' ? target.path : undefined;
  if (result.via === 'star') {
    observed.set(keyOf(file, result.span.line, '*'), {
      kind,
      ...(path !== undefined ? { path } : {}),
      via: 'star',
      names: [...result.names].sort(),
    });
    return;
  }
  for (const name of result.names) {
    observed.set(keyOf(file, result.span.line, name), {
      kind,
      ...(path !== undefined ? { path } : {}),
      via: result.via,
    });
  }
}
