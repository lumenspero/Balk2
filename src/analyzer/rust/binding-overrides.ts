import type { ConfigProblem } from '../../config/config-problem.js';
import type { RustBindingConfig } from '../../config/rust-config.js';

/** A Cargo package as the binding engine sees it, for matching configured entries to it. */
export interface BindingCrateFacts {
  /** The package name as code uses it. */
  readonly name: string;
  /** True when the package depends on the binding's library. */
  readonly dependsOn: boolean;
}

/** Package names compare with `-` and `_` alike, as Cargo does. */
function keyOf(name: string): string {
  return name.replace(/-/g, '_');
}

/**
 * The configured entries of one kind, keyed by the package they name (V3 Phase 15.3). An entry
 * whose package is missing, or does not depend on the binding's library, is reported and dropped.
 */
export function overridesOfKind<K extends RustBindingConfig['kind']>(
  bindings: readonly RustBindingConfig[] | undefined,
  kind: K,
  crates: readonly BindingCrateFacts[],
  problems: ConfigProblem[],
  library: string,
): Map<string, Extract<RustBindingConfig, { kind: K }>> {
  const overrides = new Map<string, Extract<RustBindingConfig, { kind: K }>>();
  (bindings ?? []).forEach((binding, index) => {
    if (binding.kind !== kind) return;
    const path = `rust.bindings[${index}]`;
    const key = keyOf(binding.crate);
    const matches = crates.filter((crate) => keyOf(crate.name) === key);
    if (matches.length === 0) {
      problems.push({
        path: `${path}.crate`,
        message: `no Cargo package named "${binding.crate}" in this repository; entry ignored`,
      });
      return;
    }
    if (!matches.some((crate) => crate.dependsOn)) {
      problems.push({
        path: `${path}.crate`,
        message: `"${binding.crate}" does not depend on ${library}; entry ignored`,
      });
      return;
    }
    if (overrides.has(key)) {
      problems.push({
        path,
        message: `a ${kind} entry for "${binding.crate}" already exists; entry ignored`,
      });
      return;
    }
    overrides.set(key, binding as Extract<RustBindingConfig, { kind: K }>);
  });
  return overrides;
}

/** The override configured for a package, if any. */
export function overrideFor<T extends RustBindingConfig>(
  overrides: ReadonlyMap<string, T>,
  name: string,
): T | undefined {
  return overrides.get(keyOf(name));
}
