/**
 * napi-rs bindings (V3 Phase 14.4), read from the top-level items of crates that depend on `napi`
 * or `napi-derive`. A crate without either dependency publishes nothing.
 *
 * - A `#[napi]` function is exported under its `js_name` when given, and otherwise under its name
 *   converted to camelCase, as napi-rs does (`parse_text` becomes `parseText`).
 * - A `#[napi]` struct is a class, exported under its `js_name` or its own name.
 *
 * The consumer is the JS/TS package declared by the `package.json` beside the crate's `Cargo.toml`,
 * and its name is the import specifier. That is inferred from the layout, so its confidence is
 * medium. A configured `packageName` (`rust.bindings[]`, Phase 15.3) replaces it at high confidence.
 *
 * Only top-level items are read. Methods in `impl` blocks are not bound in this phase.
 */
import * as fs from 'fs';
import { posix } from 'path';
import type { BindingExport, FrontEndBindings } from '../../bindings/types.js';
import type { Attribute, RustFile } from '../items.js';

/** The package facts the napi bindings need for one Cargo crate. */
export interface NapiCrate {
  /** Repository-relative directory of the crate's manifest, `.` for the root. */
  readonly packageDir: string;
  /** True when the crate depends on `napi` or `napi-derive`, normally or for development. */
  readonly dependsOnNapi: boolean;
  /** The `name` of the `package.json` beside the crate, when it has one. */
  readonly packageName: string | undefined;
  /** The npm package name from configuration, which replaces `packageName` when set. */
  readonly configuredPackageName?: string;
}

/** The napi-rs exports of every file of the given crates. */
export function napiBindings(
  crates: readonly NapiCrate[],
  files: ReadonlyMap<string, RustFile>,
): FrontEndBindings {
  const exports: BindingExport[] = [];
  for (const [file, parsed] of files) {
    const crate = crateOwning(file, crates);
    const packageName = crate?.configuredPackageName ?? crate?.packageName;
    if (crate === undefined || !crate.dependsOnNapi || packageName === undefined) continue;
    for (const item of parsed.items) {
      if (item.kind !== 'fn' && item.kind !== 'struct') continue;
      const attr = attrNamed(item.attrs, 'napi');
      if (attr === undefined) continue;
      const jsName = jsNameOf(attr);
      const name = jsName ?? (item.kind === 'fn' ? camelCase(item.name) : item.name);
      exports.push({
        kind: 'napi',
        side: 'rust',
        specifier: packageName,
        name,
        symbolId: `${file}:${item.name}`,
        file,
        confidence: crate.configuredPackageName !== undefined ? 'high' : 'medium',
      });
    }
  }
  return { exports, consumers: [] };
}

/** The `name` of the `package.json` beside a crate, or undefined when it is missing or unnamed. */
export function readPackageName(rootDir: string, packageDir: string): string | undefined {
  try {
    const doc = JSON.parse(
      fs.readFileSync(`${rootDir}/${posix.join(packageDir, 'package.json')}`, 'utf8'),
    ) as { name?: unknown };
    return typeof doc.name === 'string' && doc.name.length > 0 ? doc.name : undefined;
  } catch {
    return undefined;
  }
}

/** napi-rs's naming: underscores separate words, and every word after the first is capitalized. */
export function camelCase(name: string): string {
  const words = name.split('_').filter((word) => word.length > 0);
  if (words.length === 0) return name;
  return (
    words[0] +
    words
      .slice(1)
      .map((word) => word[0]?.toUpperCase() + word.slice(1))
      .join('')
  );
}

function attrNamed(attrs: readonly Attribute[], path: string): Attribute | undefined {
  return attrs.find((attr) => attr.path === path);
}

/** `js_name = name` or `js_name = "name"` in the attribute's arguments. */
function jsNameOf(attr: Attribute): string | undefined {
  return /\bjs_name\s*=\s*"?([A-Za-z_]\w*)"?/.exec(attr.raw)?.[1];
}

/** The crate whose directory holds the file, the longest such directory winning. */
function crateOwning(file: string, crates: readonly NapiCrate[]): NapiCrate | undefined {
  let best: NapiCrate | undefined;
  for (const crate of crates) {
    const dir = posix.normalize(crate.packageDir);
    const inside = dir === '.' || dir === '' || file.startsWith(`${dir}/`);
    if (!inside) continue;
    if (best === undefined || dir.length > posix.normalize(best.packageDir).length) best = crate;
  }
  return best;
}
