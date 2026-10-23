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
  /** The positional argument that holds the artifact path, counted from 0. */
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
