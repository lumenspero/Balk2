import { detectArtifactFormat } from '../data/formats.js';
import { normalizePath } from '../graph.js';
import type { ArtifactFormat, Confidence } from '../types.js';
import type { DataReferenceFact } from './types.js';

/**
 * The data engine (Phase 2.7, data). It reads data-reference facts and returns artifact edges. The
 * direction comes from the source text that uses the artifact: a write, a read, a mode flag, or a
 * fallback that is recorded with low confidence.
 */

export type DataDirection = 'generates' | 'consumes' | 'reads';

/** A direction and whether the context actually said so. */
export interface InferredDirection {
  readonly type: DataDirection;
  /**
   * True when a read or write keyword or mode flag named the direction. False when the direction
   * is only the fallback, so the caller should record it with lower confidence.
   */
  readonly certain: boolean;
}

/** One artifact edge to write. */
export interface DataEdge {
  readonly source: string;
  readonly artifact: string;
  readonly format: ArtifactFormat;
  readonly relationship: DataDirection;
  readonly confidence: Confidence;
}

const WRITE_KEYWORDS = [
  'write',
  'writefile',
  'writefilesync',
  'save',
  'dump',
  'dumps',
  'to_json',
  'to_parquet',
  'to_csv',
  'createwritestream',
];

const READ_KEYWORDS = [
  'read',
  'readfile',
  'readfilesync',
  'load',
  'parse',
  'read_json',
  'read_parquet',
  'read_csv',
  'createreadstream',
  'fetch',
];

/** Runs the data engine over every data-reference fact, in order. */
export function runDataEngine(input: { readonly facts: readonly DataReferenceFact[] }): DataEdge[] {
  return input.facts.map((fact) => {
    const direction = inferDataDirection(fact.context);
    const artifact = normalizePath(fact.path);
    return {
      source: normalizePath(fact.filePath),
      artifact,
      format: detectArtifactFormat(artifact) ?? 'unknown',
      relationship: direction.type,
      confidence: direction.certain ? 'high' : 'low',
    };
  });
}

/**
 * True when the first `open(...)` call in the text has a single argument, so no mode is given. A
 * comma at the call's own level means a mode follows. Commas inside nested calls do not count.
 */
function opensWithoutMode(text: string): boolean {
  const start = text.search(/\bopen\s*\(/);
  if (start < 0) return false;

  let depth = 0;
  for (let i = text.indexOf('(', start); i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return true;
    } else if (ch === ',' && depth === 1) {
      return false;
    }
  }
  return false;
}

/**
 * Infer whether a call context implies generating (writing) or consuming (reading) a data
 * artifact, and whether that inference rests on evidence in the context.
 */
export function inferDataDirection(callContext: string): InferredDirection {
  const lower = callContext.toLowerCase();

  for (const kw of WRITE_KEYWORDS) {
    if (lower.includes(kw)) return { type: 'generates', certain: true };
  }

  for (const kw of READ_KEYWORDS) {
    if (lower.includes(kw)) return { type: 'consumes', certain: true };
  }

  // Check for file opening mode flags e.g. open('foo.json', 'w')
  if (/(['"])(w|wb|a|w\+|wb\+)\1/i.test(lower)) {
    return { type: 'generates', certain: true };
  }

  if (/(['"])(r|rb)\1/i.test(lower)) {
    return { type: 'consumes', certain: true };
  }

  // open(path) with no mode argument reads the file.
  if (opensWithoutMode(lower)) {
    return { type: 'consumes', certain: true };
  }

  // A name such as output_dir or out_file suggests a write. It is only a hint, so confidence stays low.
  if (/\boutput|\bout_|\bdest/.test(lower)) {
    return { type: 'generates', certain: false };
  }

  return { type: 'reads', certain: false };
}

/**
 * Infer whether a function/method call context implies generating (writing) or consuming (reading) a data artifact.
 */
export function inferDataRelationshipType(callContext: string): DataDirection {
  return inferDataDirection(callContext).type;
}
