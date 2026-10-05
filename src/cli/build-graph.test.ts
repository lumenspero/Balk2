import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkConnectionMap } from './check.js';
import { generateConnectionMap } from './generate.js';

describe('generate and check share one analysis path', () => {
  let rootDir: string;

  const write = (name: string, content: string): void => {
    const full = path.join(rootDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  };

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-parity-test-'));
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    );
    write('src/util.ts', 'export const helper = 1;');
    write('src/boot.ts', 'function boot() {}');
    write(
      'src/main.ts',
      "import { helper } from '@/util';\nexport function run() { boot(); return helper; }",
    );
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  it('reports a freshly generated map as current, including tsconfig aliases', () => {
    const { map } = generateConnectionMap({ cwd: rootDir, timestamp: '2026-01-01T00:00:00.000Z' });

    // Only the shared repository session resolves the `@/*` tsconfig alias.
    expect(
      map.relationships.some(
        (r) => r.type === 'imports' && r.from === 'src/main.ts' && r.to === 'src/util.ts',
      ),
    ).toBe(true);

    expect(checkConnectionMap({ cwd: rootDir })).toMatchObject({ isCurrent: true });
  });

  it('reports the map as stale once the repository changes', () => {
    generateConnectionMap({ cwd: rootDir, timestamp: '2026-01-01T00:00:00.000Z' });
    write('src/extra.ts', 'export const extra = 2;');

    expect(checkConnectionMap({ cwd: rootDir }).isCurrent).toBe(false);
  });
});
