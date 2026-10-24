import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildConnectionGraph } from '../cli/build-graph.js';
import type { Balk2Config } from '../config/config.js';

// Each run analyzes two languages; the default 5s limit is tight on a busy machine.
vi.setConfig({ testTimeout: 60_000 });

/**
 * A Tauri command: a Rust function with `#[tauri::command]` is declared in the `commands` registry
 * under its name, and a bare `invoke('name')` in TypeScript looks it up there. The two sides meet at
 * the same key node, because they name the same registry.
 */
const FILES: Record<string, string> = {
  'Cargo.toml': '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
  'src/lib.rs': '#[tauri::command]\npub fn greet() -> String {\n    String::new()\n}\n',
  'web/bridge.ts': 'export function invoke(name: string): unknown {\n  return name;\n}\n',
  'web/app.ts':
    "import { invoke } from './bridge';\n\nexport function load(): unknown {\n  return invoke('greet');\n}\n",
};

const CONFIG = {
  protocols: {
    registries: {
      attributes: [{ name: 'tauri::command', key: 'fn-name', registry: 'commands' }],
      methods: [{ method: 'invoke', direction: 'resolve', keyArg: 0, registry: 'commands' }],
    },
  },
} as unknown as Balk2Config;

describe('Tauri commands across Rust and TypeScript', () => {
  it('connects a #[tauri::command] function to a bare invoke of its name', () => {
    const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-tauri-'));
    try {
      for (const [name, content] of Object.entries(FILES)) {
        fs.mkdirSync(path.dirname(path.join(rootDir, name)), { recursive: true });
        fs.writeFileSync(path.join(rootDir, name), content, 'utf8');
      }
      const map = buildConnectionGraph(rootDir, CONFIG).build({
        generatedAt: '2026-01-01T00:00:00Z',
      });
      const keys = Object.values(map.registryKeys).filter(
        (node) => node.key === 'greet' && node.scope === 'commands',
      );
      expect(keys).toHaveLength(1);
      const key = keys[0]!;

      const declared = map.relationships.filter(
        (r) => r.type === 'registers' && r.from === key.id && r.to.includes('greet'),
      );
      expect(declared).toHaveLength(1);

      const looked = map.relationships.filter(
        (r) => r.type === 'resolves' && r.from === 'web/app.ts:load' && r.to === key.id,
      );
      expect(looked).toHaveLength(1);
    } finally {
      fs.rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
