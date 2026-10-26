import type { ConfigProblem } from './config-problem.js';

/** The `rust` section of `.balk2.json` (V3 Phase 15.3). */
export interface RustConfig {
  readonly macros?: {
    /**
     * Macros whose arguments are code, as written before `!`. They are added to the built-in list
     * (`format`, `println`, `assert_eq`, and others), so calls inside them are found.
     */
    readonly expressionLike?: readonly string[];
  };
}

const MACRO_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Reads the `rust` section. Unknown keys and malformed names are reported and ignored; a bad macro
 * name never widens what counts as code, so the rest of the list still applies.
 */
export function normalizeRustConfig(
  value: unknown,
  problems: ConfigProblem[],
): RustConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push({ path: 'rust', message: 'must be an object' });
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== 'macros') {
      problems.push({ path: `rust.${key}`, message: 'unknown key ignored' });
    }
  }
  if (!('macros' in raw)) return {};
  const macros = normalizeMacros(raw['macros'], problems);
  return macros ? { macros } : {};
}

function normalizeMacros(
  value: unknown,
  problems: ConfigProblem[],
): RustConfig['macros'] | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push({ path: 'rust.macros', message: 'must be an object' });
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== 'expressionLike') {
      problems.push({ path: `rust.macros.${key}`, message: 'unknown key ignored' });
    }
  }
  if (!('expressionLike' in raw)) return undefined;

  const list = raw['expressionLike'];
  if (!Array.isArray(list)) {
    problems.push({
      path: 'rust.macros.expressionLike',
      message: 'must be an array of macro names',
    });
    return undefined;
  }
  const names: string[] = [];
  list.forEach((entry: unknown, index) => {
    const path = `rust.macros.expressionLike[${index}]`;
    if (typeof entry !== 'string' || !MACRO_NAME_PATTERN.test(entry)) {
      problems.push({
        path,
        message: 'must be a macro name, an identifier without "!"; entry ignored',
      });
      return;
    }
    if (!names.includes(entry)) names.push(entry);
  });
  return { expressionLike: names };
}
