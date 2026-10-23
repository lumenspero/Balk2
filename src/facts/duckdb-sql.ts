import { DUCKDB_SQL_READERS } from './data-catalog.js';

/**
 * The files a DuckDB SQL statement reads or writes (V3 Phase 11.2 and 11.6). A file a SQL function
 * reads, such as `read_parquet('x')`, is a read. The target of `COPY … TO 'x'` is a write. Shared by
 * the JavaScript and Python front ends, so both read SQL the same way.
 */
export interface DuckDbSqlTarget {
  readonly path: string;
  /** The SQL function that reads the file, lower-cased, or `copy` for a `COPY … TO`. */
  readonly name: string;
  readonly direction: 'consumes' | 'generates';
}

const READ_CALL = new RegExp(`\\b(${DUCKDB_SQL_READERS.join('|')})\\s*\\(\\s*'([^']+)'`, 'gi');
/** `COPY <anything> TO '<path>'`, with the target as the path. */
const COPY_TO = /\bCOPY\b[\s\S]*?\bTO\s*'([^']+)'/gi;

/** The reads and writes of one SQL statement, in the order they appear by kind: reads, then copies. */
export function duckDbSqlTargets(sql: string): DuckDbSqlTarget[] {
  const targets: DuckDbSqlTarget[] = [];
  for (const match of sql.matchAll(READ_CALL)) {
    targets.push({
      path: match[2] ?? '',
      name: (match[1] ?? '').toLowerCase(),
      direction: 'consumes',
    });
  }
  for (const match of sql.matchAll(COPY_TO)) {
    targets.push({ path: match[1] ?? '', name: 'copy', direction: 'generates' });
  }
  return targets;
}
