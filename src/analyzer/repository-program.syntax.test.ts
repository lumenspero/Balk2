import { describe, expect, it } from 'vitest';
import { createRepositoryFixture } from '../testing/repository-fixture.js';

const OPTIONS = { target: 'es2020', strict: true } as const;

describe('repository program: syntax errors', () => {
  it('reports the file and position of a syntax error', () => {
    const fixture = createRepositoryFixture(
      { 'good.ts': 'export const a = 1;', 'bad.ts': 'export const b = 1;\nconst x = ;' },
      OPTIONS,
    );
    try {
      const notes = fixture.repository.syntaxErrors();
      expect(notes.length).toBeGreaterThan(0);
      expect(notes.every((note) => note.path === 'bad.ts')).toBe(true);
      expect(notes[0]?.line).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  it('reports nothing for a repository without syntax errors', () => {
    const fixture = createRepositoryFixture({ 'good.ts': 'export const a = 1;' }, OPTIONS);
    try {
      expect(fixture.repository.syntaxErrors()).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });
});
