import type { Expr, Stmt } from './ast.js';
import { parseModuleRecovering } from './statement-parser.js';

/**
 * The inventory of one Python file, in the format test/python-oracle/dump_inventory.py
 * prints for CPython's ast. Each entry is a string, and each list is sorted, so the two
 * sides can be compared exactly. Columns are not part of the format.
 */
export interface FileInventory {
  readonly syntaxError: boolean;
  readonly definitions: readonly string[];
  readonly imports: readonly string[];
  readonly calls: readonly string[];
  readonly assignments: readonly string[];
}

type Node = { readonly kind: string; readonly span?: { readonly line: number } } & Record<
  string,
  unknown
>;

/** A dotted name for a name or attribute chain, otherwise '?'. Matches chain() in the oracle script. */
function chain(e: Expr): string {
  if (e.kind === 'name') return e.id;
  if (e.kind === 'attribute') {
    const base = chain(e.value);
    return base === '?' ? '?' : `${base}.${e.attr}`;
  }
  return '?';
}

/** The assignment leaves of a target, looking through tuples, lists and starred targets. */
function leaves(target: Expr): Expr[] {
  switch (target.kind) {
    case 'tuple':
    case 'list':
      return target.elements.flatMap(leaves);
    case 'starred':
      return leaves(target.value);
    default:
      return [target];
  }
}

const aliasText = (alias: { readonly name: string; readonly asname: string | null }): string =>
  alias.asname === null ? alias.name : `${alias.name} as ${alias.asname}`;

/** Calls `visit` on every node that has a kind, at any depth. Spans are skipped. */
function walk(value: unknown, visit: (node: Node) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.kind === 'string') visit(record as Node);
  for (const key of Object.keys(record)) {
    if (key !== 'span') walk(record[key], visit);
  }
}

export function inventoryOf(source: string): FileInventory {
  const parsed = parseModuleRecovering(source);
  if (parsed.errors.length > 0) {
    return { syntaxError: true, definitions: [], imports: [], calls: [], assignments: [] };
  }
  const definitions: string[] = [];
  const imports: string[] = [];
  const calls: string[] = [];
  const assignments: string[] = [];

  const recordTargets = (targets: readonly (Expr | null | undefined)[]): void => {
    for (const target of targets) {
      if (target === null || target === undefined) continue;
      for (const leaf of leaves(target))
        assignments.push(`assign ${chain(leaf)}@${leaf.span.line}`);
    }
  };

  walk(parsed.body as unknown, (node) => {
    const stmt = node as unknown as Stmt & { readonly span: { readonly line: number } };
    switch (node.kind) {
      case 'funcdef':
        definitions.push(`def ${String(node.name)}@${stmt.span.line}`);
        break;
      case 'classdef':
        definitions.push(`class ${String(node.name)}@${stmt.span.line}`);
        break;
      case 'typealias':
        definitions.push(`type ${String(node.name)}@${stmt.span.line}`);
        break;
      case 'import': {
        const names = node.names as readonly { name: string; asname: string | null }[];
        imports.push(`import ${names.map(aliasText).join(',')}@${stmt.span.line}`);
        break;
      }
      case 'importfrom': {
        const dots = '.'.repeat(Number(node.level));
        const names = node.names as 'star' | readonly { name: string; asname: string | null }[];
        const body = names === 'star' ? '*' : names.map(aliasText).join(',');
        imports.push(`from ${dots}${String(node.module ?? '')} import ${body}@${stmt.span.line}`);
        break;
      }
      case 'call':
        calls.push(`call ${chain(node.func as Expr)}@${stmt.span.line}`);
        break;
      case 'assign':
        recordTargets(node.targets as Expr[]);
        break;
      case 'augassign':
      case 'annassign':
      case 'for':
      case 'namedexpr':
        recordTargets([node.target as Expr]);
        break;
      case 'with':
        recordTargets((node.items as { target: Expr | null }[]).map((item) => item.target));
        break;
      case 'comprehension':
        recordTargets((node.generators as { target: Expr }[]).map((gen) => gen.target));
        break;
      default:
        break;
    }
  });

  return {
    syntaxError: false,
    definitions: definitions.sort(),
    imports: imports.sort(),
    calls: calls.sort(),
    assignments: assignments.sort(),
  };
}
