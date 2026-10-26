import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createRepositoryProgram } from './repository-program.js';

/**
 * The TypeScript oracle (V3 Phase 16.1). For every import, re-export and require specifier in the
 * fixtures under test/ts-oracle, Balk2's JS/TS resolution must agree with `ts.resolveModuleName`,
 * the function the TypeScript compiler itself uses.
 *
 * Specifiers are read with TypeScript's scanner (`ts.preProcessFile`), not with Balk2's own
 * extraction, so a specifier Balk2 fails to see is still checked. Each file uses its nearest
 * tsconfig.json at or above it, inside the case, as Balk2 does.
 *
 * Expected outcomes, in the same terms as the production classification:
 * - TypeScript resolves the specifier to a file in the case: internal, at that path. Balk2 must
 *   get it from TypeScript (`resolution: 'typescript'`), not from its fallback.
 * - TypeScript resolves it elsewhere, or a bare specifier does not resolve: external.
 * - A relative or absolute specifier that does not resolve: unresolved.
 */

const ORACLE_ROOT = fileURLToPath(new URL('../../test/ts-oracle', import.meta.url));
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

interface Outcome {
  readonly kind: 'internal' | 'external' | 'unresolved';
  readonly path?: string;
}

/** Every file under a directory, as forward-slash paths relative to it. */
function listFiles(directory: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(directory, prefix)).sort()) {
    const rel = prefix === '' ? entry : `${prefix}/${entry}`;
    if (statSync(path.join(directory, rel)).isDirectory()) out.push(...listFiles(directory, rel));
    else out.push(rel);
  }
  return out;
}

/** The compiler options of the nearest tsconfig.json at or above a file, stopping at the case. */
function optionsFor(caseRoot: string, file: string): ts.CompilerOptions {
  let dir = path.dirname(path.join(caseRoot, file));
  for (;;) {
    const configPath = path.join(dir, 'tsconfig.json');
    if (ts.sys.fileExists(configPath)) {
      const read = ts.readConfigFile(configPath, ts.sys.readFile);
      if (read.error) throw new Error(`cannot read ${configPath}`);
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
      return { ...parsed.options, allowJs: true, noEmit: true };
    }
    if (dir === caseRoot) throw new Error(`no tsconfig.json for ${file} in ${caseRoot}`);
    dir = path.dirname(dir);
  }
}

/** What TypeScript says a specifier means, from a file in the case. */
function oracle(
  caseRoot: string,
  knownFiles: ReadonlySet<string>,
  file: string,
  spec: string,
): Outcome {
  const resolved = ts.resolveModuleName(
    spec,
    path.join(caseRoot, file),
    optionsFor(caseRoot, file),
    ts.sys,
  ).resolvedModule;
  if (resolved) {
    const rel = path.relative(caseRoot, resolved.resolvedFileName).split(path.sep).join('/');
    return knownFiles.has(rel) ? { kind: 'internal', path: rel } : { kind: 'external' };
  }
  const relativeOrAbsolute = spec.startsWith('.') || path.isAbsolute(spec);
  return { kind: relativeOrAbsolute ? 'unresolved' : 'external' };
}

const caseNames = readdirSync(ORACLE_ROOT)
  .filter((name) => statSync(path.join(ORACLE_ROOT, name)).isDirectory())
  .sort();

describe('TypeScript resolution: Balk2 matches ts.resolveModuleName (V3 Phase 16.1)', () => {
  it('has fixture cases', () => {
    expect(caseNames.length).toBeGreaterThan(0);
  });

  for (const name of caseNames) {
    it(name, () => {
      const caseRoot = path.join(ORACLE_ROOT, name);
      const sourceFiles = listFiles(caseRoot).filter((file) => SOURCE.test(file));
      const knownFiles = new Set(sourceFiles);
      const program = createRepositoryProgram({ rootDir: caseRoot, filePaths: sourceFiles });

      let checked = 0;
      for (const file of sourceFiles) {
        const text = readFileSync(path.join(caseRoot, file), 'utf8');
        const specs = ts.preProcessFile(text, true, true).importedFiles.map((ref) => ref.fileName);
        for (const spec of specs) {
          checked += 1;
          const expected = oracle(caseRoot, knownFiles, file, spec);
          const got = program.resolveModule(file, spec);
          const label = `${file} imports '${spec}'`;
          expect({ kind: got.kind, path: got.path }, label).toEqual(
            expected.path === undefined
              ? { kind: expected.kind, path: undefined }
              : { kind: expected.kind, path: expected.path },
          );
          if (expected.kind === 'internal') {
            expect(got.resolution, `${label}: must come from TypeScript`).toBe('typescript');
          }
        }
      }
      // A case with no specifiers would pass vacuously.
      expect(checked, `${name} has specifiers to check`).toBeGreaterThan(0);
    });
  }
});
