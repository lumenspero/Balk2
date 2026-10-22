import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseRustFile, type Item } from './items.js';
import { lexRust, type RustTokenKind } from './lexer.js';
import { rustSyntaxNotes } from './syntax-notes.js';
import { buildTokenTrees } from './token-tree.js';

const FIXTURE_ROOT = fileURLToPath(new URL('../../../test/fixtures', import.meta.url));

/** Every `test/fixtures/rust-*` directory, with its `lib.rs`. */
function rustFixtures(): { name: string; source: string }[] {
  return readdirSync(FIXTURE_ROOT)
    .filter((name) => name.startsWith('rust-') && statSync(join(FIXTURE_ROOT, name)).isDirectory())
    .sort()
    .map((name) => ({ name, source: readFileSync(join(FIXTURE_ROOT, name, 'lib.rs'), 'utf8') }));
}

const FIXTURES = rustFixtures();

/** A small seeded generator, so the random cut points are the same on every run. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every line end, plus seeded random offsets, so cuts land inside tokens, groups and items. */
function cutPoints(source: string, seed: number): number[] {
  const cuts = new Set<number>([0, source.length]);
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') cuts.add(i);
  }
  const random = mulberry32(seed);
  for (let k = 0; k < 300; k += 1) cuts.add(Math.floor(random() * (source.length + 1)));
  return [...cuts].sort((a, b) => a - b);
}

/** The kind of every item, including items nested in inline modules. */
function itemKinds(items: readonly Item[], out: string[] = []): string[] {
  for (const item of items) {
    out.push(item.kind);
    if (item.kind === 'mod') itemKinds(item.items, out);
  }
  return out;
}

describe('rust fixtures', () => {
  it('finds the rust fixtures', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(5);
  });

  for (const fixture of FIXTURES) {
    it(`parses ${fixture.name} with no syntax notes and no unknown items`, () => {
      const parsed = parseRustFile(fixture.source);
      expect(parsed.errors).toEqual([]);
      expect(rustSyntaxNotes(fixture.name, fixture.source)).toEqual([]);
      expect(itemKinds(parsed.items)).not.toContain('unknown');
    });
  }

  it('covers every token class across the fixtures', () => {
    const kinds = new Set<RustTokenKind>();
    for (const fixture of FIXTURES) {
      for (const token of lexRust(fixture.source).tokens) kinds.add(token.kind);
    }
    const required: RustTokenKind[] = [
      'ident',
      'lifetime',
      'int',
      'float',
      'char',
      'byte',
      'str',
      'byte_str',
      'c_str',
      'punct',
    ];
    expect(required.filter((kind) => !kinds.has(kind))).toEqual([]);
    expect(kinds.has('error')).toBe(false);
  });

  it('covers every item form across the fixtures', () => {
    const seen = new Set<string>();
    for (const fixture of FIXTURES) {
      for (const kind of itemKinds(parseRustFile(fixture.source).items)) seen.add(kind);
    }
    const required = [
      'const',
      'enum',
      'extern_block',
      'extern_crate',
      'fn',
      'impl',
      'macro_call',
      'macro_rules',
      'mod',
      'static',
      'struct',
      'trait',
      'type',
      'union',
      'use',
    ];
    expect(required.filter((kind) => !seen.has(kind))).toEqual([]);
  });
});

describe('rust robustness: truncated input', () => {
  FIXTURES.forEach((fixture, index) => {
    it(`never throws and always returns for every cut of ${fixture.name}`, () => {
      const failures: string[] = [];
      for (const cut of cutPoints(fixture.source, 6500 + index)) {
        const prefix = fixture.source.slice(0, cut);
        try {
          const lexed = lexRust(prefix);
          buildTokenTrees(lexed.tokens);
          parseRustFile(prefix);
        } catch (error) {
          failures.push(`cut ${cut}: ${String(error)}`);
        }
      }
      expect(failures.slice(0, 5)).toEqual([]);
    });
  });
});

describe('rust robustness: malformed input', () => {
  const malformed: [string, string][] = [
    ['an unclosed brace', 'fn f() {'],
    ['an unmatched closing brace', 'fn f() {} }'],
    ['a mismatched delimiter', 'fn f() { let x = (1; }'],
    ['an unterminated string', 'fn f() { let s = "open; }'],
    ['an unterminated block comment', '/* open'],
    ['an unclosed module', 'mod m {\nfn a() {}'],
  ];

  for (const [label, source] of malformed) {
    it(`reports syntax notes for ${label}`, () => {
      const notes = rustSyntaxNotes('bad.rs', source);
      expect(notes.length).toBeGreaterThan(0);
      expect(notes.every((note) => note.path === 'bad.rs' && note.line >= 1)).toBe(true);
    });
  }
});
