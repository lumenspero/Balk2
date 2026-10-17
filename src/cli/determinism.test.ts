import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateConnectionMap } from './generate.js';

// Each case runs the full analysis several times; the default 5s limit is too tight on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

const FIXED_TIMESTAMP = '2026-01-01T00:00:00.000Z';

const FILES: Readonly<Record<string, string>> = {
  'tsconfig.json': JSON.stringify({
    compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
  }),
  'src/util.ts': 'export const helper = 1;',
  'src/boot.ts': 'function boot() {}',
  'src/main.ts':
    "import { helper } from '@/util';\nexport function run() { boot(); return helper; }",
  'src/other.ts': "import { run } from './main';\nexport const again = () => run();",
};
const NAMES = Object.keys(FILES);

const roots: string[] = [];

function makeRepository(order: readonly string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-determinism-'));
  roots.push(dir);
  for (const name of order) {
    const content = FILES[name];
    if (content === undefined) throw new Error(`no fixture content for ${name}`);
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function generate(cwd: string): { json: string; md: string; hasEdge: boolean } {
  const result = generateConnectionMap({ cwd, timestamp: FIXED_TIMESTAMP });
  return {
    json: fs.readFileSync(result.jsonPath, 'utf8'),
    md: fs.readFileSync(result.mdPath, 'utf8'),
    hasEdge: result.map.relationships.some(
      (r) => r.type === 'references' && r.from === 'src/main.ts:run' && r.to === 'src/boot.ts:boot',
    ),
  };
}

describe('connection map output is deterministic', () => {
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('produces byte-identical JSON and Markdown on repeated runs', () => {
    const dir = makeRepository(NAMES);
    const first = generate(dir);
    const second = generate(dir);

    expect(second.json).toBe(first.json);
    expect(second.md).toBe(first.md);
  });

  it('does not depend on the order in which files were created', () => {
    const forward = generate(makeRepository(NAMES));
    const reversed = generate(makeRepository([...NAMES].reverse()));

    expect(reversed.json).toBe(forward.json);
    expect(reversed.md).toBe(forward.md);
  });

  it('compares real output, not an empty map', () => {
    const output = generate(makeRepository(NAMES));

    expect(output.hasEdge).toBe(true);
    expect(output.json.length).toBeGreaterThan(0);
    expect(output.md.length).toBeGreaterThan(0);
  });
});
