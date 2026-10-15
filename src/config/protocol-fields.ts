import type { ConfigProblem } from './config-problem.js';

/** Method names are JavaScript identifiers. */
export const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;
/** Argument positions are small; anything beyond this is not a call convention. */
export const MAX_ARG_INDEX = 15;

/** A list of non-empty strings, `[]` when absent, `null` when malformed. */
export function stringList(
  value: unknown,
  present: boolean,
  path: string,
  problems: ConfigProblem[],
): string[] | null {
  if (!present) return [];
  if (!Array.isArray(value)) {
    problems.push({ path, message: 'must be an array of strings' });
    return null;
  }

  const list: string[] = [];
  let valid = true;
  value.forEach((item: unknown, index) => {
    if (typeof item === 'string' && item.length > 0) {
      if (!list.includes(item)) list.push(item);
    } else {
      problems.push({ path: `${path}[${index}]`, message: 'must be a non-empty string' });
      valid = false;
    }
  });
  return valid ? list : null;
}

export function argField(
  entry: Record<string, unknown>,
  key: string,
  applies: boolean,
  appliesTo: string,
  path: string,
  problems: ConfigProblem[],
): number | undefined {
  if (!(key in entry)) return undefined;
  const value = entry[key];
  if (!isArgIndex(value)) {
    problems.push({
      path: `${path}.${key}`,
      message: `must be an integer from 0 to ${MAX_ARG_INDEX}; field ignored`,
    });
    return undefined;
  }
  if (!applies) return dropped(`${path}.${key}`, `only applies to ${appliesTo}`, problems);
  return value;
}

export function dropped(path: string, reason: string, problems: ConfigProblem[]): undefined {
  problems.push({ path, message: `${reason}; field ignored` });
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isArgIndex(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_ARG_INDEX
  );
}
