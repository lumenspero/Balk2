import type { FactLanguage } from './types.js';

/**
 * The data lineage catalog (V3 Phase 11). Each entry names a library API by the module it is
 * imported from and the export it uses, and gives the direction of the artifact it touches. The
 * data engine uses an entry only when the front end has resolved a call to that API, so a method
 * named `read` on some other object never reads a file.
 */

/** Direction of a data artifact relative to the code that uses it. */
export type CatalogDirection = 'generates' | 'consumes' | 'reads';

/** One catalog entry. `module` is the bare module name, so `node:fs` is written `fs`. */
export interface DataApiEntry {
  readonly module: string;
  /** The export name the call uses. */
  readonly name: string;
  readonly direction: CatalogDirection;
  readonly languages: readonly FactLanguage[];
  /** True for a URL path served from a public folder (Phase 11.6). See `DataApiMatch.served`. */
  readonly served?: boolean;
  /**
   * The positional argument that holds the artifact path, counted from 0. `-1` names the receiver
   * of a method call, so `Path('x.json').read_text()` reads the path the receiver holds (Phase 11.6).
   */
  readonly argument: number;
}

const JS_TS: readonly FactLanguage[] = ['javascript', 'typescript'];
const PYTHON: readonly FactLanguage[] = ['python'];
const RUST: readonly FactLanguage[] = ['rust'];

function entriesFor(
  module: string,
  names: readonly string[],
  direction: CatalogDirection,
  languages: readonly FactLanguage[],
  argument = 0,
): DataApiEntry[] {
  return names.map((name) => ({ module, name, direction, languages, argument }));
}

const FS_READ = ['readFile', 'readFileSync', 'createReadStream'];
const MOVE = ['copyFile', 'copyFileSync', 'rename', 'renameSync'];
const FS_WRITE = [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'createWriteStream',
];

/** Catalog entries for JavaScript and TypeScript (Phase 11.1). The path is always the first argument. */
export const JS_TS_DATA_APIS: readonly DataApiEntry[] = [
  ...entriesFor('fs', FS_READ, 'consumes', JS_TS),
  ...entriesFor('fs', FS_WRITE, 'generates', JS_TS),
  ...entriesFor('fs/promises', FS_READ, 'consumes', JS_TS),
  ...entriesFor('fs/promises', FS_WRITE, 'generates', JS_TS),
  // A copy or rename reads its source (argument 0) and writes its destination (argument 1).
  ...entriesFor('fs', MOVE, 'consumes', JS_TS, 0),
  ...entriesFor('fs', MOVE, 'generates', JS_TS, 1),
  ...entriesFor('fs/promises', MOVE, 'consumes', JS_TS, 0),
  ...entriesFor('fs/promises', MOVE, 'generates', JS_TS, 1),
  // The global `fetch` (Phase 11.6). Its path is a URL path, served from the package's public folder.
  {
    module: 'global',
    name: 'fetch',
    direction: 'consumes',
    languages: JS_TS,
    argument: 0,
    served: true,
  },
];

/**
 * Catalog entries for Python (Phase 11.2). Modules are the names the code imports, so `import
 * pyarrow.parquet as pq` gives `pyarrow.parquet`. `builtins.open` is not listed here: its direction
 * depends on its mode argument, so the Python front end reads that itself.
 */
export const PYTHON_DATA_APIS: readonly DataApiEntry[] = [
  ...entriesFor(
    'pandas',
    ['read_csv', 'read_parquet', 'read_json', 'read_excel', 'read_feather'],
    'consumes',
    PYTHON,
  ),
  ...entriesFor(
    'polars',
    ['read_csv', 'read_parquet', 'read_json', 'scan_csv', 'scan_parquet'],
    'consumes',
    PYTHON,
  ),
  ...entriesFor('duckdb', ['read_csv', 'read_parquet', 'read_json'], 'consumes', PYTHON),
  ...entriesFor('pyarrow.parquet', ['read_table'], 'consumes', PYTHON),
  ...entriesFor('pyarrow.parquet', ['write_table'], 'generates', PYTHON, 1),
  ...entriesFor('numpy', ['load', 'loadtxt'], 'consumes', PYTHON),
  ...entriesFor('numpy', ['save', 'savez', 'savez_compressed', 'savetxt'], 'generates', PYTHON),
  ...entriesFor('shutil', ['copy', 'copy2', 'copyfile'], 'consumes', PYTHON, 0),
  ...entriesFor('shutil', ['copy', 'copy2', 'copyfile'], 'generates', PYTHON, 1),
  ...entriesFor('sqlite3', ['connect'], 'reads', PYTHON),
  // Methods on a `pathlib.Path` receiver read or write the path the receiver holds (Phase 11.6).
  ...entriesFor('pathlib.Path', ['read_text', 'read_bytes'], 'consumes', PYTHON, -1),
  ...entriesFor('pathlib.Path', ['write_text', 'write_bytes'], 'generates', PYTHON, -1),
  // Writers on a DataFrame read by pandas take the destination as their first argument.
  ...entriesFor(
    'pandas.DataFrame',
    ['to_csv', 'to_parquet', 'to_json', 'to_excel', 'to_feather'],
    'generates',
    PYTHON,
    0,
  ),
];

/**
 * Catalog entries for Rust (Phase 11.3). Modules are full Rust paths joined with `::`, so
 * `std::fs::File::open` is module `std::fs::File` with name `open`. Method chains such as
 * `OpenOptions::new().write(true).open(p)` are not matched: the call's receiver is a chain.
 */
export const RUST_DATA_APIS: readonly DataApiEntry[] = [
  ...entriesFor('std::fs', ['read', 'read_to_string'], 'consumes', RUST),
  ...entriesFor('std::fs', ['write'], 'generates', RUST),
  ...entriesFor('std::fs', ['copy'], 'consumes', RUST, 0),
  ...entriesFor('std::fs', ['copy'], 'generates', RUST, 1),
  ...entriesFor('std::fs::File', ['open'], 'consumes', RUST),
  ...entriesFor('std::fs::File', ['create'], 'generates', RUST),
  // A chain `OpenOptions::new().write(true)…open(p)` takes its direction from its flags, which the
  // resolver reads, so the entry here is the path's position only (Phase 11.6).
  ...entriesFor('std::fs::OpenOptions', ['open'], 'consumes', RUST),
  ...entriesFor('csv::Reader', ['from_path'], 'consumes', RUST),
  ...entriesFor('csv::Writer', ['from_path'], 'generates', RUST),
  ...entriesFor('rusqlite::Connection', ['open'], 'reads', RUST),
  ...entriesFor('polars::prelude', ['scan_csv', 'scan_parquet'], 'consumes', RUST),
  ...entriesFor('polars::prelude::CsvReader', ['from_path'], 'consumes', RUST),
];

/**
 * The entry for an API the front end resolved, in one language, when the artifact is passed as
 * the given positional argument. Returns undefined when no entry names that argument.
 */
export function lookupDataApi(
  language: FactLanguage,
  module: string,
  name: string,
  argument = 0,
): DataApiEntry | undefined {
  return [...JS_TS_DATA_APIS, ...PYTHON_DATA_APIS, ...RUST_DATA_APIS].find(
    (entry) =>
      entry.module === module &&
      entry.name === name &&
      entry.argument === argument &&
      entry.languages.includes(language),
  );
}

/** The npm module whose `Database` runs SQL that can read and write files (Phase 11.6). */
export const DUCKDB_MODULE = 'duckdb';

/** Methods of a DuckDB database or connection whose first argument is SQL. */
export const DUCKDB_SQL_METHODS: readonly string[] = ['all', 'run', 'exec', 'each', 'prepare'];

/** SQL functions that read the file named by their first string argument. */
export const DUCKDB_SQL_READERS: readonly string[] = [
  'read_csv',
  'read_csv_auto',
  'read_parquet',
  'read_json',
  'read_json_auto',
  'read_json_objects',
  'parquet_scan',
  'csv_scan',
];
