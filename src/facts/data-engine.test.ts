import { describe, expect, it } from 'vitest';
import { runDataEngine } from './data-engine.js';
import type { DataReferenceFact } from './types.js';

const span = { filePath: 'src/build.ts', startLine: 1, startColumn: 1, endLine: 1, endColumn: 20 };

function reference(overrides: Partial<DataReferenceFact> = {}): DataReferenceFact {
  return {
    kind: 'data-reference',
    filePath: 'src/build.ts',
    span,
    path: 'data/out.json',
    context: 'use(path)',
    ...overrides,
  };
}

function directionOf(context: string): { relationship: string; confidence: string } {
  const [edge] = runDataEngine({ facts: [reference({ context })] });
  return { relationship: edge.relationship, confidence: edge.confidence };
}

describe('runDataEngine', () => {
  it('links the source to the artifact it writes, with high confidence', () => {
    const [edge] = runDataEngine({
      facts: [reference({ context: 'fs.writeFileSync(path, data)' })],
    });
    expect(edge).toMatchObject({
      source: 'src/build.ts',
      artifact: 'data/out.json',
      relationship: 'generates',
      confidence: 'high',
    });
  });

  it('links the source to the artifact it reads, with high confidence', () => {
    expect(directionOf('fs.readFileSync(path)')).toEqual({
      relationship: 'consumes',
      confidence: 'high',
    });
  });

  it('takes the direction from a mode flag', () => {
    expect(directionOf("open(path, 'w')")).toEqual({
      relationship: 'generates',
      confidence: 'high',
    });
  });

  it('reads an open call that gives no mode', () => {
    expect(directionOf('open(path)')).toEqual({ relationship: 'consumes', confidence: 'high' });
  });

  it('infers a write from an output name, with low confidence', () => {
    expect(directionOf('const output_dir = pick()')).toEqual({
      relationship: 'generates',
      confidence: 'low',
    });
  });

  it('falls back to a read, with low confidence, when nothing names the direction', () => {
    expect(directionOf('use(path)')).toEqual({ relationship: 'reads', confidence: 'low' });
  });
});
