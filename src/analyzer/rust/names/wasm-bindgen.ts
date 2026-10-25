/**
 * wasm-bindgen bindings (V3 Phase 14.2), read from the parsed Rust files of crates that depend on
 * `wasm-bindgen`. A crate without that dependency publishes nothing, so a same-named module in
 * another crate gets no edge.
 *
 * - Exports: a free `#[wasm_bindgen]` function, named by `js_name` when given. It is published
 *   under the wasm-pack output path `<crate>/pkg/<lib>.js`, which is inferred from the defaults,
 *   so its confidence is medium.
 * - Imports: a function in an `extern` block with `module = "..."` (relative to the crate root)
 *   or `raw_module = "..."` (relative to the file). Its JS export name is `js_name` or the Rust
 *   name, and the function is the consumer's owner.
 *
 * Only top-level items are read. Functions inside inline modules, `impl` blocks and configured
 * output directories are not yet bound.
 */
import { posix } from 'path';
import type { BindingConsumer, BindingExport, FrontEndBindings } from '../../bindings/types.js';
import type { SourceSpan } from '../../../types.js';
import type { Attribute, Span, RustFile } from '../items.js';

/** The package facts the bindings need for one Cargo crate. */
export interface WasmBindgenCrate {
  /** Repository-relative directory of the crate's manifest, `.` for the root. */
  readonly packageDir: string;
  /** The crate name as code uses it (`-` changed to `_`). */
  readonly libName: string;
  /** True when the crate depends on `wasm_bindgen`, normally or for development. */
  readonly dependsOnWasmBindgen: boolean;
}

const WASM_PATH = 'wasm_bindgen';

/** The wasm-bindgen bindings published by every file of the given crates. */
export function wasmBindgenBindings(
  crates: readonly WasmBindgenCrate[],
  files: ReadonlyMap<string, RustFile>,
): FrontEndBindings {
  const exports: BindingExport[] = [];
  const consumers: BindingConsumer[] = [];
  for (const [file, parsed] of files) {
    const crate = crateOwning(file, crates);
    if (crate === undefined || !crate.dependsOnWasmBindgen) continue;

    for (const item of parsed.items) {
      if (item.kind === 'fn') {
        const attr = wasmAttr(item.attrs);
        if (attr === undefined || moduleTargetOf(attr) !== undefined) continue;
        exports.push({
          kind: 'wasm-bindgen',
          side: 'rust',
          specifier: posix.join(crate.packageDir, 'pkg', `${crate.libName}.js`),
          name: jsNameOf(attr) ?? item.name,
          symbolId: `${file}:${item.name}`,
          file,
          confidence: 'medium',
        });
      } else if (item.kind === 'extern_block') {
        const blockAttr = wasmAttr(item.attrs);
        const blockTarget = blockAttr === undefined ? undefined : moduleTargetOf(blockAttr);
        for (const child of item.items) {
          if (child.kind !== 'fn') continue;
          const childAttr = wasmAttr(child.attrs);
          const childTarget = childAttr === undefined ? undefined : moduleTargetOf(childAttr);
          const target = childTarget ?? blockTarget;
          if (target === undefined) continue;
          consumers.push({
            kind: 'wasm-bindgen',
            side: 'rust',
            specifier: resolveModule(target, file, crate.packageDir),
            name: (childAttr === undefined ? undefined : jsNameOf(childAttr)) ?? child.name,
            file,
            span: spanOf(child.span, file),
            owner: `${file}:${child.name}`,
          });
        }
      }
    }
  }
  return { exports, consumers };
}

/** Where a `module` or `raw_module` argument points: the crate root, or the file's directory. */
interface ModuleTarget {
  readonly base: 'crate' | 'file';
  readonly path: string;
}

function wasmAttr(attrs: readonly Attribute[]): Attribute | undefined {
  return attrs.find((attr) => attr.path === WASM_PATH);
}

function moduleTargetOf(attr: Attribute): ModuleTarget | undefined {
  const match = /\b(module|raw_module)\s*=\s*"([^"]*)"/.exec(attr.raw);
  if (!match) return undefined;
  return { base: match[1] === 'module' ? 'crate' : 'file', path: match[2] ?? '' };
}

function jsNameOf(attr: Attribute): string | undefined {
  // `js_name` takes a bare identifier, so the value may or may not be quoted.
  return /\bjs_name\s*=\s*"?([A-Za-z_]\w*)"?/.exec(attr.raw)?.[1];
}

function resolveModule(target: ModuleTarget, file: string, packageDir: string): string {
  return target.base === 'crate'
    ? // A leading slash is relative to the crate root, not the file system root.
      posix.join(packageDir, target.path.replace(/^\/+/, ''))
    : posix.join(posix.dirname(file), target.path);
}

/** The crate whose directory holds the file, the longest such directory winning. */
function crateOwning(
  file: string,
  crates: readonly WasmBindgenCrate[],
): WasmBindgenCrate | undefined {
  let best: WasmBindgenCrate | undefined;
  for (const crate of crates) {
    const dir = posix.normalize(crate.packageDir);
    const inside = dir === '.' || dir === '' || file.startsWith(`${dir}/`);
    if (!inside) continue;
    if (best === undefined || dir.length > posix.normalize(best.packageDir).length) best = crate;
  }
  return best;
}

function spanOf(span: Span, file: string): SourceSpan {
  return {
    filePath: file,
    startLine: span.line,
    startColumn: span.column,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}
