/**
 * Directories a Python file stores on `self`, so `self.<attr> / "name.json"` can be recorded as the
 * full relative path. Only literal values are used, in two forms:
 *   def __init__(self, output_dir: str = "data/targets"): ... self.output_dir = Path(output_dir)
 *   self.output_dir = "data/targets"
 * Directories built from other values are not guessed. The scope is the whole file, so two
 * classes that use one attribute name for different directories are not told apart.
 */

/** A `name: type = "literal"` default on a def line. */
const DEFAULT_PARAM = /\b(\w+)\s*(?::\s*[\w\[\], .]+)?\s*=\s*(["'])([^"'\s]+)\2/g;
/** `self.attr = "literal"` or `self.attr = Path("literal")`. */
const SELF_FROM_LITERAL = /\bself\.(\w+)\s*=\s*(?:Path\(\s*)?(["'])([^"'\s]+)\2/;
/** `self.attr = param` or `self.attr = Path(param)`, the whole line. */
const SELF_FROM_PARAM = /^self\.(\w+)\s*=\s*(?:Path\(\s*)?(\w+)\s*\)?$/;
/** `self.attr / "piece"` with a literal piece. */
const SELF_JOIN = /\bself\.(\w+)\s*\/\s*(["'])([^"'\s]+)\2/g;

/** A directory: a plain relative path whose last segment has no file extension. */
function isDirectoryLiteral(value: string): boolean {
  return (
    !value.includes('://') &&
    !value.startsWith('/') &&
    !/[{}]/.test(value) &&
    !/\.[A-Za-z0-9]+$/.test(value.replace(/\/+$/, ''))
  );
}

/** Map of attribute name to the literal directory it holds, for one Python file. */
export function selfDirectories(lines: readonly string[]): Map<string, string> {
  const params = new Map<string, string>();
  for (const line of lines) {
    for (const match of line.matchAll(DEFAULT_PARAM)) {
      const value = match[3] ?? '';
      if (isDirectoryLiteral(value)) params.set(match[1] ?? '', value);
    }
  }

  const dirs = new Map<string, string>();
  for (const raw of lines) {
    const line = raw.trim();
    const literal = SELF_FROM_LITERAL.exec(line);
    if (literal) {
      const value = literal[3] ?? '';
      if (isDirectoryLiteral(value)) dirs.set(literal[1] ?? '', value);
      continue;
    }
    const fromParam = SELF_FROM_PARAM.exec(line);
    if (fromParam) {
      const value = params.get(fromParam[2] ?? '');
      if (value !== undefined) dirs.set(fromParam[1] ?? '', value);
    }
  }
  return dirs;
}

/** A `self.attr / "piece"` join whose attribute holds a known directory. `end` is exclusive. */
export interface SelfJoin {
  readonly value: string;
  readonly index: number;
  readonly end: number;
}

export function selfJoinSpans(line: string, dirs: ReadonlyMap<string, string>): SelfJoin[] {
  const joins: SelfJoin[] = [];
  for (const match of line.matchAll(SELF_JOIN)) {
    const dir = dirs.get(match[1] ?? '');
    if (dir === undefined) continue;
    const index = match.index ?? 0;
    const value = `${dir.replace(/\/+$/, '')}/${match[3] ?? ''}`;
    joins.push({ value, index, end: index + match[0].length });
  }
  return joins;
}
