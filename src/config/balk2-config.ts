import {
  normalizePathBaseConfig,
  validatePathBaseConfig,
  type PathBaseConfig,
} from './path-base-config.js';
import { normalizePythonConfig, type PythonConfig } from './python-config.js';
import * as fs from 'fs';
import * as path from 'path';
import type { Annotation } from '../analyzer/annotations.js';
import type { ConfigProblem } from './config-problem.js';
import { normalizeAnnotations } from './annotations-config.js';
import { normalizeProtocolsConfig, type ProtocolsConfig } from './protocols-config.js';
import { normalizeStateConfig, type StateConfig } from './state-config.js';

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
  /** Explicit data lineage rules */
  readonly lineage?: readonly DataLineageEntry[];
  /** The order bare relative data paths are placed in (Phase 11.4). */
  readonly pathBase?: PathBaseConfig;
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
  /** Project conventions for indirect connections (event protocols) */
  readonly protocols?: ProtocolsConfig;
  /** What counts as shared state and how it is accessed */
  readonly state?: StateConfig;
  /** Project decisions that set the confidence of existing relationships */
  readonly annotations?: readonly Annotation[];
  /** Python analysis configuration */
  readonly python?: PythonConfig;
}

/** The loaded configuration plus everything in the file that was ignored or unusable. */
export interface LoadedBalk2Config {
  /** Undefined when there is no file, or it is not a JSON object */
  readonly config?: Balk2Config;
  readonly problems: readonly ConfigProblem[];
}

/**
 * Load and parse .balk2.json configuration file if present.
 *
 * Unusable content is dropped. `generate` and `check` print each dropped entry as a warning on
 * stderr; use {@link loadBalk2ConfigDetailed} to get the same list programmatically.
 */
export function loadBalk2Config(
  cwd: string = process.cwd(),
  customPath?: string,
): Balk2Config | undefined {
  return loadBalk2ConfigDetailed(cwd, customPath).config;
}

/**
 * Like {@link loadBalk2Config}, but also reports every entry that was dropped, so a mistyped
 * setting is visible instead of silently doing nothing.
 */
export function loadBalk2ConfigDetailed(
  cwd: string = process.cwd(),
  customPath?: string,
): LoadedBalk2Config {
  const configPath = customPath
    ? path.resolve(cwd, customPath)
    : path.join(path.resolve(cwd), '.balk2.json');

  if (!fs.existsSync(configPath)) {
    return { problems: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      problems: [{ path: '', message: `could not read or parse configuration: ${reason}` }],
    };
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { problems: [{ path: '', message: 'configuration must be a JSON object' }] };
  }

  const raw = parsed as Record<string, unknown>;
  const problems: ConfigProblem[] = [];
  const config: Record<string, unknown> = { ...raw };
  if ('version' in raw && raw.version !== 2) {
    problems.push({
      path: 'version',
      message: 'unsupported configuration version; this release reads version 2',
    });
  }
  delete config.globals;
  delete config.protocols;
  delete config.state;
  delete config.annotations;
  delete config.python;

  if ('globals' in raw) {
    problems.push(...validateGlobalsConfig(raw.globals));
    const globals = normalizeGlobalsConfig(raw.globals);
    if (globals) config.globals = globals;
  }

  if ('protocols' in raw) {
    const protocols = normalizeProtocolsConfig(raw.protocols);
    problems.push(...protocols.problems);
    if (protocols.config) config.protocols = protocols.config;
  }

  if ('state' in raw) {
    const state = normalizeStateConfig(raw.state);
    problems.push(...state.problems);
    if (state.config) config.state = state.config;
  }

  if ('annotations' in raw) {
    const annotations = normalizeAnnotations(raw.annotations, problems);
    if (annotations) config.annotations = annotations;
  }

  if ('python' in raw) {
    const python = normalizePythonConfig(raw.python, problems);
    if (python) config.python = python;
  }

  if ('data' in raw) {
    problems.push(...validateDataConfig(raw.data));
    const data = raw.data;
    if (typeof data === 'object' && data !== null && !Array.isArray(data) && 'pathBase' in data) {
      problems.push(...validatePathBaseConfig(data.pathBase));
      config.data = { ...data, pathBase: normalizePathBaseConfig(data.pathBase) };
    }
  }

  return { config: config as Balk2Config, problems };
}

/**
 * Keys in `data` that the loader does not read. `data.extensions` was removed in 2.0.0, so a
 * configuration copied from 1.x is otherwise ignored without a word.
 */
export function validateDataConfig(value: unknown): ConfigProblem[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ path: 'data', message: 'must be an object' }];
  }
  return Object.keys(value)
    .filter((key) => key !== 'lineage' && key !== 'pathBase')
    .map((key) => ({ path: `data.${key}`, message: 'unknown key ignored' }));
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

/** What {@link normalizeGlobalsConfig} would drop from this `globals` value. */
export function validateGlobalsConfig(value: unknown): ConfigProblem[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ path: 'globals', message: 'must be an object' }];
  }

  const raw = value as Record<string, unknown>;
  const problems: ConfigProblem[] = [];

  for (const key of Object.keys(raw)) {
    if (key !== 'roots' && key !== 'targets') {
      problems.push({ path: `globals.${key}`, message: 'unknown key ignored' });
    }
  }

  if ('roots' in raw) {
    const roots = raw.roots;
    if (!Array.isArray(roots)) {
      problems.push({ path: 'globals.roots', message: 'must be an array of identifiers' });
    } else {
      let valid = 0;
      roots.forEach((entry: unknown, index) => {
        if (typeof entry === 'string' && IDENTIFIER_PATTERN.test(entry)) {
          valid++;
        } else {
          problems.push({ path: `globals.roots[${index}]`, message: 'must be an identifier' });
        }
      });
      if (roots.length > 0 && valid === 0) {
        problems.push({
          path: 'globals.roots',
          message: 'has no valid identifiers; the default roots are kept',
        });
      }
    }
  }

  if ('targets' in raw) {
    const targets = raw.targets;
    if (typeof targets !== 'object' || targets === null || Array.isArray(targets)) {
      problems.push({ path: 'globals.targets', message: 'must be an object of name to file path' });
    } else {
      for (const [name, file] of Object.entries(targets)) {
        if (name.length === 0) {
          problems.push({ path: 'globals.targets', message: 'a target name must not be empty' });
        } else if (typeof file !== 'string' || file.length === 0) {
          problems.push({
            path: `globals.targets.${name}`,
            message: 'must be a non-empty file path',
          });
        }
      }
    }
  }

  return problems;
}
