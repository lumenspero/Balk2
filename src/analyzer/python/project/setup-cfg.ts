/** The raw entries of one `[section]` of a setup.cfg file: lower-cased keys to raw values. */
export type IniSection = ReadonlyMap<string, string>;

export interface SetupCfgError {
  readonly line: number;
  readonly message: string;
}

export interface SetupCfgParse {
  /** Section names are lower-cased. A section that repeats is merged. */
  readonly sections: ReadonlyMap<string, IniSection>;
  readonly errors: readonly SetupCfgError[];
}

/**
 * Parse the subset of setup.cfg that package discovery reads: `[section]` headers, `key = value`
 * or `key: value` lines, comments, and indented continuation lines. A line that fits none of these
 * is reported and skipped, so the parser never throws.
 */
export function parseSetupCfg(text: string): SetupCfgParse {
  const sections = new Map<string, Map<string, string>>();
  const errors: SetupCfgError[] = [];
  let section: Map<string, string> | undefined;
  let key: string | undefined;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? '';
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;

    if (/^\s/.test(raw)) {
      if (section && key !== undefined) {
        section.set(key, `${section.get(key) ?? ''}\n${trimmed}`);
      } else {
        errors.push({ line, message: 'continuation line with no key' });
      }
      continue;
    }

    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      const name = (header[1] ?? '').trim().toLowerCase();
      section = sections.get(name) ?? new Map<string, string>();
      sections.set(name, section);
      key = undefined;
      continue;
    }

    const pair = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(trimmed);
    if (!section || !pair) {
      errors.push({ line, message: section ? 'expected key = value' : 'key outside any section' });
      key = undefined;
      continue;
    }
    key = (pair[1] ?? '').trim().toLowerCase();
    section.set(key, (pair[2] ?? '').trim());
  }
  return { sections, errors };
}

/** Split a setup.cfg list value, which is comma- or newline-separated, into non-empty entries. */
export function listValue(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}
