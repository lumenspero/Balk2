/**
 * Whether a concrete npm version satisfies a version range (V3 Phase 7.5). Only the forms that
 * workspace packages use in practice are understood: `*`, `x`, exact versions, `=`, `^`, `~`, and
 * x-ranges such as `1`, `1.x` and `1.2.x`. Any other syntax, and any prerelease or build suffix,
 * returns `undefined`, so the caller can decline to draw an edge rather than guess.
 *
 * @param version a plain `X.Y.Z` version, optionally with a leading `v`
 * @param range the range as written in a dependency
 */
export function satisfiesRange(version: string, range: string): boolean | undefined {
  const exact = parseVersion(version);
  if (exact === undefined) return undefined;
  const text = range.trim();
  if (text === '' || text === '*' || text === 'x' || text === 'X') return true;

  if (text.startsWith('^') || text.startsWith('~')) {
    const base = parseParts(text.slice(1));
    if (base === undefined) return undefined;
    const bounds = text.startsWith('^') ? caretBounds(base) : tildeBounds(base);
    return inBounds(exact, bounds);
  }

  const literal = (text.startsWith('=') ? text.slice(1) : text).replace(/^v/, '');
  const parts = parseParts(literal);
  if (parts === undefined) return undefined;
  if (parts.length === 3 && parts.every((part) => part !== undefined)) {
    return compare(exact, parts as Version) === 0;
  }
  return inBounds(exact, xRangeBounds(parts));
}

type Version = readonly [number, number, number];
/** A version whose components may be wildcards (`undefined`), of one to three components. */
type Parts = readonly (number | undefined)[];

interface Bounds {
  readonly low: Version;
  readonly high: Version;
}

const PLAIN_VERSION = /^v?(\d+)\.(\d+)\.(\d+)$/;

function parseVersion(text: string): Version | undefined {
  const match = PLAIN_VERSION.exec(text.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function parseParts(text: string): Parts | undefined {
  const pieces = text.split('.');
  if (pieces.length > 3) return undefined;
  const parts: (number | undefined)[] = [];
  for (const piece of pieces) {
    if (piece === 'x' || piece === 'X' || piece === '*') parts.push(undefined);
    else if (/^\d+$/.test(piece)) parts.push(Number(piece));
    else return undefined;
  }
  // A wildcard may not be followed by a number: `1.x.3` is not a range.
  const firstWild = parts.indexOf(undefined);
  if (firstWild !== -1 && parts.slice(firstWild).some((part) => part !== undefined))
    return undefined;
  if (parts[0] === undefined) return undefined;
  return parts;
}

/** `^1.2.3` is `>=1.2.3 <2.0.0`. The leftmost non-zero component fixes the upper bound. */
function caretBounds(parts: Parts): Bounds {
  const major = parts[0] ?? 0;
  const minor = parts[1];
  const patch = parts[2];
  const low: Version = [major, minor ?? 0, patch ?? 0];
  if (major > 0 || minor === undefined) return { low, high: [major + 1, 0, 0] };
  if (minor > 0 || patch === undefined) return { low, high: [0, minor + 1, 0] };
  return { low, high: [0, 0, patch + 1] };
}

/** `~1.2.3` is `>=1.2.3 <1.3.0`. `~1` is `>=1.0.0 <2.0.0`. */
function tildeBounds(parts: Parts): Bounds {
  const major = parts[0] ?? 0;
  const minor = parts[1];
  const low: Version = [major, minor ?? 0, parts[2] ?? 0];
  if (minor === undefined) return { low, high: [major + 1, 0, 0] };
  return { low, high: [major, minor + 1, 0] };
}

/** An x-range: `1` and `1.x` are `>=1.0.0 <2.0.0`, and `1.2.x` is `>=1.2.0 <1.3.0`. */
function xRangeBounds(parts: Parts): Bounds {
  const major = parts[0] ?? 0;
  const minor = parts[1];
  const low: Version = [major, minor ?? 0, 0];
  if (minor === undefined) return { low, high: [major + 1, 0, 0] };
  return { low, high: [major, minor + 1, 0] };
}

function inBounds(version: Version, bounds: Bounds): boolean {
  return compare(version, bounds.low) >= 0 && compare(version, bounds.high) < 0;
}

function compare(a: Version, b: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
