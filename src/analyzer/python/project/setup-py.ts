import type { ParseNote } from '../cursor.js';
import type { Expr, Stmt } from '../ast.js';
import { parseModuleRecovering } from '../statement-parser.js';
import { joinRepoPath } from './paths.js';

/** The literal facts a `setup.py` declares. Anything computed at run time is left out. */
export interface SetupPyFacts {
  readonly name?: string;
  /** Repository-relative import root directories, from literal `package_dir` and `packages` */
  readonly roots: readonly string[];
  /** Syntax notes from the file. A file that does not parse still yields the facts it has. */
  readonly notes: readonly ParseNote[];
}

/**
 * Read the literal arguments of a `setup()` call in `setup.py` (V3 Phase 4.1). The call is looked
 * for at top level and inside top-level `if` blocks, such as `if __name__ == "__main__":`.
 *
 * - `name="..."` gives the distribution name.
 * - `package_dir={"": "src"}` gives the root `src`.
 * - `packages=[...]` with no `""` mapping gives the repository root.
 * - `packages=find_packages(where="src")` gives `src`, and no `where` gives the repository root.
 *
 * Any other value is not read, because it is computed at run time.
 */
export function readSetupPy(dir: string, source: string): SetupPyFacts {
  const parsed = parseModuleRecovering(source);
  const call = findSetupCall(parsed.body);
  if (!call) return { roots: [], notes: parsed.errors };

  const keyword = (name: string): Expr | undefined =>
    call.args.find((arg) => arg.kind === 'keyword' && arg.name === name)?.value;

  const roots: string[] = [];
  let hasEmptyMapping = false;
  const packageDir = keyword('package_dir');
  if (packageDir?.kind === 'dict') {
    for (const entry of packageDir.entries) {
      if (!entry.key || simpleString(entry.key) !== '') continue;
      const value = simpleString(entry.value);
      if (value !== undefined) {
        roots.push(joinRepoPath(dir, value));
        hasEmptyMapping = true;
      }
    }
  }

  const packages = keyword('packages');
  if (packages?.kind === 'list' || packages?.kind === 'tuple') {
    if (!hasEmptyMapping) roots.push(joinRepoPath(dir, '.'));
  } else if (packages?.kind === 'call' && isFindPackages(packages.func)) {
    const where = packages.args.find((arg) => arg.kind === 'keyword' && arg.name === 'where');
    const value = where ? simpleString(where.value) : '.';
    if (value !== undefined) roots.push(joinRepoPath(dir, value));
  }

  const nameExpr = keyword('name');
  const name = nameExpr ? simpleString(nameExpr) : undefined;
  return {
    ...(name !== undefined && name !== '' ? { name } : {}),
    roots: [...new Set(roots)].sort(),
    notes: parsed.errors,
  };
}

/** A `setup(...)` call at top level, or inside a top-level `if` block. */
function findSetupCall(body: readonly Stmt[]): Extract<Expr, { kind: 'call' }> | undefined {
  for (const stmt of body) {
    if (stmt.kind === 'expr' && isSetupCall(stmt.value)) return stmt.value;
    if (stmt.kind === 'assign' && isSetupCall(stmt.value)) return stmt.value;
    if (stmt.kind === 'if') {
      const nested = findSetupCall(stmt.body) ?? findSetupCall(stmt.orelse);
      if (nested) return nested;
    }
  }
  return undefined;
}

function isSetupCall(expr: Expr): expr is Extract<Expr, { kind: 'call' }> {
  if (expr.kind !== 'call') return false;
  return (
    (expr.func.kind === 'name' && expr.func.id === 'setup') ||
    (expr.func.kind === 'attribute' && expr.func.attr === 'setup')
  );
}

function isFindPackages(func: Expr): boolean {
  const name = func.kind === 'name' ? func.id : func.kind === 'attribute' ? func.attr : undefined;
  return name === 'find_packages' || name === 'find_namespace_packages';
}

/** A plain string literal's value: one quoted pair with no escapes. */
function simpleString(expr: Expr): string | undefined {
  if (expr.kind !== 'constant' || expr.type !== 'str') return undefined;
  const match = /^(['"])([^'"\\]*)\1$/.exec(expr.raw);
  return match ? (match[2] ?? '') : undefined;
}
