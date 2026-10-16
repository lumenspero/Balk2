import type { Annotation } from '../analyzer/annotations.js';
import type { ConfigProblem } from './config-problem.js';
import { isRecord } from './protocol-fields.js';

const BASE = 'annotations';
const ANNOTATION_KEYS = new Set(['type', 'from', 'to', 'confidence']);
const CONFIDENCES = ['high', 'medium', 'low'] as const;

/**
 * Validate the top-level `annotations` section of `.balk2.json`. Every field is required: an
 * annotation without a confidence would change nothing, and an unknown confidence value is rejected
 * rather than guessed. A malformed entry is dropped and reported.
 */
export function normalizeAnnotations(
  value: unknown,
  problems: ConfigProblem[],
): Annotation[] | undefined {
  if (!Array.isArray(value)) {
    problems.push({ path: BASE, message: 'must be an array' });
    return undefined;
  }

  const annotations: Annotation[] = [];
  value.forEach((entry: unknown, index) => {
    const path = `${BASE}[${index}]`;
    const annotation = normalizeAnnotation(entry, path, problems);
    if (annotation) annotations.push(annotation);
  });

  return annotations.length > 0 ? annotations : undefined;
}

function normalizeAnnotation(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): Annotation | undefined {
  if (!isRecord(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }

  for (const key of Object.keys(value)) {
    if (!ANNOTATION_KEYS.has(key)) {
      problems.push({ path: `${path}.${key}`, message: 'unknown key ignored' });
    }
  }

  const type = value['type'];
  const from = value['from'];
  const to = value['to'];
  for (const [name, field] of [
    ['type', type],
    ['from', from],
    ['to', to],
  ] as const) {
    if (typeof field !== 'string' || field.length === 0) {
      problems.push({
        path: `${path}.${name}`,
        message: 'must be a non-empty string; entry ignored',
      });
      return undefined;
    }
  }

  const confidence = value['confidence'];
  if (!CONFIDENCES.some((allowed) => allowed === confidence)) {
    problems.push({
      path: `${path}.confidence`,
      message: `must be one of ${CONFIDENCES.join(', ')}; entry ignored`,
    });
    return undefined;
  }

  return {
    type: type as Annotation['type'],
    from: from as string,
    to: to as string,
    confidence: confidence as Annotation['confidence'],
  };
}
