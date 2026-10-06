import * as fs from 'fs';
import * as path from 'path';

export interface DataLineageEntry {
  /** Source code script/file that produces data output */
  readonly producer?: string;
  /** Source code component/file that consumes data input */
  readonly consumer?: string;
  /** Input data artifact path or array of paths */
  readonly input?: string | readonly string[];
  /** Output data artifact path or array of paths */
  readonly output?: string | readonly string[];
}

export interface DataConfig {
  /** Custom data file extensions to recognize (e.g. ['.json', '.parquet']) */
  readonly extensions?: readonly string[];
  /** Explicit data lineage rules */
  readonly lineage?: readonly DataLineageEntry[];
}

export interface GlobalsConfig {
  /**
   * Identifiers that denote the global object. Replaces the defaults
   * (`globalThis`, `window`, `self`, `global`) when provided; drop `self` or
   * `window` for projects where those are common local names.
   */
  readonly roots?: readonly string[];
  /**
   * Picks the owning file for a global name declared in several files,
   * e.g. `{ "init": "src/legacy/init.js" }`. Without a target a duplicated
   * name produces no edge.
   */
  readonly targets?: Readonly<Record<string, string>>;
}

export interface Balk2Config {
  /** Glob or path patterns of files to include */
  readonly include?: readonly string[];
  /** Glob or path patterns of files to exclude */
  readonly exclude?: readonly string[];
  /** Output directory or base file path */
  readonly output?: string;
  /** Data artifact configuration */
  readonly data?: DataConfig;
  /** Global-symbol analysis configuration */
  readonly globals?: GlobalsConfig;
}

/**
 * Load and parse .balk2.json configuration file if present.
 */
export function loadBalk2Config(
  cwd: string = process.cwd(),
  customPath?: string,
): Balk2Config | undefined {
  const configPath = customPath
    ? path.resolve(cwd, customPath)
    : path.join(path.resolve(cwd), '.balk2.json');

  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const config: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
      delete config.globals;
      const globals = normalizeGlobalsConfig((parsed as Record<string, unknown>).globals);
      if (globals) config.globals = globals;
      return config as Balk2Config;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const IDENTIFIER_PATTERN = /^[A-Za-z_$][\w$]*$/;

/**
 * Keep only well-formed `globals` entries. Malformed entries are dropped rather than
 * thrown on, so a typo cannot silently disable the default roots: `roots` is ignored
 * unless it is an array with at least one valid identifier (or is explicitly empty).
 */
export function normalizeGlobalsConfig(value: unknown): GlobalsConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;

  let roots: string[] | undefined;
  if (Array.isArray(raw.roots)) {
    const valid = raw.roots.filter(
      (entry): entry is string => typeof entry === 'string' && IDENTIFIER_PATTERN.test(entry),
    );
    if (valid.length > 0 || raw.roots.length === 0) roots = [...new Set(valid)];
  }

  let targets: Record<string, string> | undefined;
  if (typeof raw.targets === 'object' && raw.targets !== null && !Array.isArray(raw.targets)) {
    const entries = Object.entries(raw.targets as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        entry[0].length > 0 && typeof entry[1] === 'string' && entry[1].length > 0,
    );
    if (entries.length > 0) targets = Object.fromEntries(entries);
  }

  if (!roots && !targets) return undefined;
  return { ...(roots ? { roots } : {}), ...(targets ? { targets } : {}) };
}
