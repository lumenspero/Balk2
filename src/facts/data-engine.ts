import { detectArtifactFormat } from '../data/formats.js';
import { normalizePath } from '../graph.js';
import type { ArtifactFormat, Confidence } from '../types.js';
import { hasBareCandidate, resolveBarePath, type BareBases } from './path-value.js';
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
];

/**
 * How a bare relative path is placed in the repository (Phase 11.4). `exists` tells whether a
 * repository path is a scanned file, and `bases` gives the bases for one fact's file.
 */
export interface DataPathContext {
  readonly exists: (repoPath: string) => boolean;
  readonly bases: (fact: DataReferenceFact) => BareBases;
}

/** The repository path an artifact fact names, or the path as written when no context is given. */
function artifactPathOf(fact: DataReferenceFact, paths: DataPathContext | undefined): string {
  const written = normalizePath(fact.path);
  if (paths === undefined || written.startsWith('../') || written.startsWith('/')) return written;
  return resolveBarePath(written, paths.bases(fact), paths.exists) ?? written;
}

/** Runs the data engine over every data-reference fact, in order. */
export function runDataEngine(input: {
  readonly facts: readonly DataReferenceFact[];
  readonly paths?: DataPathContext;
}): DataEdge[] {
  return input.facts.map((fact) => {
    const artifact = artifactPathOf(fact, input.paths);
    // A call the front end resolved to a catalog API has a known direction (Phase 11.1). A served
    // URL path with no candidate file keeps the keyword rule, at low confidence (Phase 11.6).
    const unplaced =
      fact.api?.served === true &&
      input.paths !== undefined &&
      !hasBareCandidate(normalizePath(fact.path), input.paths.bases(fact), input.paths.exists);
    const keyword = inferDataDirection(fact.context);
    const direction: InferredDirection =
      fact.api && !unplaced
        ? { type: fact.api.direction, certain: true }
        : fact.api
          ? { type: keyword.type, certain: false }
          : keyword;
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

  // `fetch` reads, but the catalog decides whether the call is the global, so the keyword is only a
  // guess (Phase 11.6).
  if (lower.includes('fetch')) return { type: 'consumes', certain: false };

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
