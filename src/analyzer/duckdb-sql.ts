import * as ts from 'typescript';
import { DUCKDB_MODULE, DUCKDB_SQL_METHODS, DUCKDB_SQL_READERS } from '../facts/data-catalog.js';
import { isDataPathLiteral } from '../facts/path-value.js';
import type { DataReferenceFact } from '../facts/types.js';
import { resolveCallee } from './data-api.js';
import type { DataResolution } from './data-facts.js';
import { accessContext } from './data-literals.js';
import { spanOf } from './spans.js';

/**
 * Data lineage for DuckDB SQL (V3 Phase 11.6). The first argument of a method on a DuckDB database
 * or connection is SQL. A file the SQL reads, such as `read_parquet('x')`, is a read; the target of
 * `COPY … TO 'x'` is a write. A handle is a `const` bound to `new duckdb.Database(…)`, or to
 * `connect()` on one, so an unrelated object with an `all` method is never matched. Only a plain
 * string or template with no substitutions is read as SQL.
 */

const READ_CALL = new RegExp(`\\b(${DUCKDB_SQL_READERS.join('|')})\\s*\\(\\s*'([^']+)'`, 'gi');
/** `COPY <anything> TO '<path>'`, with the target as the path. */
const COPY_TO = /\bCOPY\b[\s\S]*?\bTO\s*'([^']+)'/gi;

/** The data facts a SQL literal names, when the literal is the first argument of a handle's method. */
export function duckDbFacts(
  literal: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
  sourceFile: ts.SourceFile,
  filePath: string,
  resolution: DataResolution,
): DataReferenceFact[] {
  const call = literal.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== literal) return [];
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return [];
  if (!DUCKDB_SQL_METHODS.includes(callee.name.text)) return [];
  if (!isDuckDbHandle(callee.expression, resolution.checker)) return [];

  const facts: DataReferenceFact[] = [];
  const add = (path: string, name: string, direction: 'consumes' | 'generates'): void => {
    if (!isDataPathLiteral(path)) return;
    facts.push({
      kind: 'data-reference',
      filePath,
      span: spanOf(literal, filePath),
      path,
      context: accessContext(literal, sourceFile),
      api: { module: DUCKDB_MODULE, name, direction },
    });
  };
  const sql = literal.text;
  for (const match of sql.matchAll(READ_CALL)) {
    add(match[2] ?? '', (match[1] ?? '').toLowerCase(), 'consumes');
  }
  for (const match of sql.matchAll(COPY_TO)) {
    add(match[1] ?? '', 'copy', 'generates');
  }
  return facts;
}

/**
 * True when an expression is a DuckDB database, or a connection made from one. A name is followed
 * to its declaration, which must be a `const`, so a reassigned name is not a handle.
 */
function isDuckDbHandle(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  let node: ts.Expression = expression;
  if (ts.isIdentifier(node)) {
    const declaration = checker.getSymbolAtLocation(node)?.valueDeclaration;
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      !ts.isVariableDeclarationList(declaration.parent) ||
      !(declaration.parent.flags & ts.NodeFlags.Const) ||
      declaration.initializer === undefined
    ) {
      return false;
    }
    node = declaration.initializer;
  }

  if (ts.isNewExpression(node)) {
    const resolved = resolveCallee(node.expression, checker);
    return resolved?.module === DUCKDB_MODULE && resolved.name === 'Database';
  }
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    return (
      node.expression.name.text === 'connect' && isDuckDbHandle(node.expression.expression, checker)
    );
  }
  return false;
}
