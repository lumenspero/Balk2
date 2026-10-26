import type { ConfigProblem } from './config-problem.js';

/**
 * One `rust.bindings[]` entry (V3 Phase 15.3). Each names a Cargo package by `crate`, and overrides
 * one value the binding engine otherwise infers. A configured value is high confidence.
 */
export type RustBindingConfig =
  | { readonly kind: 'wasm-bindgen'; readonly crate: string; readonly outDir?: string }
  | { readonly kind: 'napi'; readonly crate: string; readonly packageName?: string }
  | { readonly kind: 'pyo3'; readonly crate: string; readonly pythonModule?: string };

/** The `rust` section of `.balk2.json` (V3 Phase 15.3). */
export interface RustConfig {
  readonly macros?: {
    /**
     * Macros whose arguments are code, as written before `!`. They are added to the built-in list
     * (`format`, `println`, `assert_eq`, and others), so calls inside them are found.
     */
    readonly expressionLike?: readonly string[];
  };
  readonly bindings?: readonly RustBindingConfig[];
}

const MACRO_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CRATE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const PACKAGE_NAME_PATTERN = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const PYTHON_MODULE_PATTERN = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;

/** The keys each binding kind accepts, besides `kind` and `crate`. */
const BINDING_KEYS: Readonly<Record<RustBindingConfig['kind'], readonly string[]>> = {
  'wasm-bindgen': ['outDir'],
  napi: ['packageName'],
  pyo3: ['pythonModule'],
};

/**
 * Reads the `rust` section. Unknown keys and malformed values are reported and ignored; a bad value
 * never widens what counts as code or changes a binding, so the rest of the section still applies.
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
    if (key !== 'macros' && key !== 'bindings') {
      problems.push({ path: `rust.${key}`, message: 'unknown key ignored' });
    }
  }
  const config: { macros?: RustConfig['macros']; bindings?: readonly RustBindingConfig[] } = {};
  if ('macros' in raw) {
    const macros = normalizeMacros(raw['macros'], problems);
    if (macros) config.macros = macros;
  }
  if ('bindings' in raw) {
    const bindings = normalizeBindings(raw['bindings'], problems);
    if (bindings) config.bindings = bindings;
  }
  return config;
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

function normalizeBindings(
  value: unknown,
  problems: ConfigProblem[],
): readonly RustBindingConfig[] | undefined {
  if (!Array.isArray(value)) {
    problems.push({ path: 'rust.bindings', message: 'must be an array' });
    return undefined;
  }
  const bindings: RustBindingConfig[] = [];
  value.forEach((entry: unknown, index) => {
    const binding = normalizeBinding(entry, `rust.bindings[${index}]`, problems);
    if (binding) bindings.push(binding);
  });
  return bindings;
}

function normalizeBinding(
  value: unknown,
  path: string,
  problems: ConfigProblem[],
): RustBindingConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    problems.push({ path, message: 'must be an object; entry ignored' });
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const kind = raw['kind'];
  if (kind !== 'wasm-bindgen' && kind !== 'napi' && kind !== 'pyo3') {
    problems.push({
      path: `${path}.kind`,
      message: 'must be wasm-bindgen, napi or pyo3; entry ignored',
    });
    return undefined;
  }

  const allowed = new Set(['kind', 'crate', ...BINDING_KEYS[kind]]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      problems.push({
        path: `${path}.${key}`,
        message: `not used by a ${kind} binding; ignored`,
      });
    }
  }

  const crate = raw['crate'];
  if (typeof crate !== 'string' || !CRATE_NAME_PATTERN.test(crate)) {
    problems.push({
      path: `${path}.crate`,
      message: 'must be a Cargo package name; entry ignored',
    });
    return undefined;
  }

  if (kind === 'wasm-bindgen') {
    if (!('outDir' in raw)) return { kind, crate };
    const outDir = normalizeOutDir(raw['outDir']);
    if (outDir === undefined) {
      problems.push({
        path: `${path}.outDir`,
        message: 'must be a repository-relative directory; entry ignored',
      });
      return undefined;
    }
    return { kind, crate, outDir };
  }

  if (kind === 'napi') {
    if (!('packageName' in raw)) return { kind, crate };
    const packageName = raw['packageName'];
    if (typeof packageName !== 'string' || !PACKAGE_NAME_PATTERN.test(packageName)) {
      problems.push({
        path: `${path}.packageName`,
        message: 'must be an npm package name; entry ignored',
      });
      return undefined;
    }
    return { kind, crate, packageName };
  }

  if (!('pythonModule' in raw)) return { kind, crate };
  const pythonModule = raw['pythonModule'];
  if (typeof pythonModule !== 'string' || !PYTHON_MODULE_PATTERN.test(pythonModule)) {
    problems.push({
      path: `${path}.pythonModule`,
      message: 'must be a dotted Python module name; entry ignored',
    });
    return undefined;
  }
  return { kind, crate, pythonModule };
}

/** A repository-relative directory without a leading `/`, `..` or `\`, with `./` and a trailing `/` removed. */
function normalizeOutDir(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  if (value.startsWith('/') || value.includes('\\') || value.split('/').includes('..'))
    return undefined;
  const trimmed = value.replace(/^\.\//, '').replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : '.';
}
