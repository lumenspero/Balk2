import type { FactLanguage } from './types.js';

/**
 * The data lineage catalog (V3 Phase 11). Each entry names a library API by the module it is
 * imported from and the export it uses, and gives the direction of the artifact it touches. The
 * data engine uses an entry only when the front end has resolved a call to that API, so a
 * method named `read` on some other object never reads a file.
 */

/** Direction of a data artifact relative to the code that uses it. */
export type CatalogDirection = 'generates' | 'consumes';

/** One catalog entry. `module` uses the bare name, so `node:fs` is written `fs`. */
export interface DataApiEntry {
  readonly module: string;
  /** The export name the call uses. */
  readonly name: string;
  readonly direction: CatalogDirection;
  readonly languages: readonly FactLanguage[];
}

const JS_TS: readonly FactLanguage[] = ['javascript', 'typescript'];

const READ_EXPORTS: readonly string[] = ['readFile', 'readFileSync', 'createReadStream'];
const WRITE_EXPORTS: readonly string[] = [
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'createWriteStream',
];

function entriesFor(
  module: string,
  names: readonly string[],
  direction: CatalogDirection,
): DataApiEntry[] {
  return names.map((name) => ({ module, name, direction, languages: JS_TS }));
}

/** Catalog entries for JavaScript and TypeScript (Phase 11.1). */
export const JS_TS_DATA_APIS: readonly DataApiEntry[] = [
  ...entriesFor('fs', READ_EXPORTS, 'consumes'),
  ...entriesFor('fs', WRITE_EXPORTS, 'generates'),
  ...entriesFor('fs/promises', READ_EXPORTS, 'consumes'),
  ...entriesFor('fs/promises', WRITE_EXPORTS, 'generates'),
];

/** The entry for an API the front end resolved, in one language, or undefined. */
export function lookupDataApi(
  language: FactLanguage,
  module: string,
  name: string,
): DataApiEntry | undefined {
  return JS_TS_DATA_APIS.find(
    (entry) => entry.module === module && entry.name === name && entry.languages.includes(language),
  );
}
