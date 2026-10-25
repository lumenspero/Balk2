/**
 * PyO3 and maturin bindings (V3 Phase 14.3), read from the crates that depend on `pyo3`.
 *
 * A `#[pymodule]` function names a Python extension module. Its module name is, in order: the
 * `[tool.maturin] module-name` of the crate's `pyproject.toml` (high), the `#[pyo3(name = "...")]`
 * on the function (high), or the function's own name (medium). Its members are the functions
 * registered in its body with `wrap_pyfunction!`, the classes registered with `add_class::<T>()`,
 * and every item marked `#[pymodule_export]`. A member resolves only when its name is unique in
 * the crate, so a name that two modules define gets no edge.
 *
 * Only top-level `#[pymodule]` functions are read.
 */
import * as fs from 'fs';
import { posix } from 'path';
import { parse as parseToml } from 'smol-toml';
import type { BindingExport, FrontEndBindings } from '../../bindings/types.js';
import type { Attribute, RustFile } from '../items.js';
import { isTokenGroup, type TokenGroup, type TokenTree } from '../token-tree.js';
import type { RustCrateIndex } from './module-index.js';

/** The package facts the PyO3 bindings need for one Cargo crate. */
export interface Pyo3Crate {
  /** Repository-relative directory of the crate's manifest, `.` for the root. */
  readonly packageDir: string;
  /** True when the crate depends on `pyo3`, normally or for development. */
  readonly dependsOnPyo3: boolean;
  /** `[tool.maturin] module-name` from the crate's `pyproject.toml`, when it names one. */
  readonly maturinModule: string | undefined;
  /** The crate's parsed items and names, for resolving members. */
  readonly index: RustCrateIndex;
}

/** A function or class a module can export, as the crate declares it. */
interface Member {
  readonly rustName: string;
  readonly symbolId: string;
  readonly file: string;
  readonly pythonName: string;
  readonly exported: boolean;
}

/** The PyO3 modules and their members, for the crates that depend on `pyo3`. */
export function pyo3Bindings(
  crates: readonly Pyo3Crate[],
  files: ReadonlyMap<string, RustFile>,
): FrontEndBindings {
  const exports: BindingExport[] = [];
  const membersByCrate = new Map<Pyo3Crate, Member[]>();
  for (const [file, parsed] of files) {
    const crate = crateOwning(file, crates);
    if (crate === undefined || !crate.dependsOnPyo3) continue;
    let members = membersByCrate.get(crate);
    if (members === undefined) {
      members = membersOf(crate.index);
      membersByCrate.set(crate, members);
    }

    for (const item of parsed.items) {
      if (item.kind !== 'fn') continue;
      const moduleAttr = attrNamed(item.attrs, 'pymodule');
      if (moduleAttr === undefined) continue;
      const pyo3Name = pyo3NameOf(item.attrs);
      const moduleName = crate.maturinModule ?? pyo3Name ?? item.name;
      const confidence =
        crate.maturinModule !== undefined || pyo3Name !== undefined ? 'high' : 'medium';
      const body = item.body === null ? '' : flatten(item.body);

      const registered = new Set<string>();
      for (const match of body.matchAll(/wrap_pyfunction\s*!\s*\(\s*([A-Za-z_][\w:]*)/g)) {
        registered.add(lastSegment(match[1] ?? ''));
      }
      for (const match of body.matchAll(/add_class\s*::\s*<\s*([A-Za-z_][\w:]*)\s*>/g)) {
        registered.add(lastSegment(match[1] ?? ''));
      }
      // `#[pymodule_export]` items are members of every module in their crate.
      for (const member of members) {
        if (member.exported || registered.has(member.rustName)) {
          const unique = members.filter((m) => m.rustName === member.rustName).length === 1;
          if (!unique) continue;
          exports.push({
            kind: 'pyo3',
            side: 'rust',
            specifier: moduleName,
            name: member.pythonName,
            symbolId: member.symbolId,
            file: member.file,
            confidence,
          });
        }
      }
    }
  }
  return { exports: exports, consumers: [] };
}

/**
 * The module name from the crate's `pyproject.toml`, beside its `Cargo.toml`, or undefined when
 * the file is missing or does not set `[tool.maturin] module-name`.
 */
export function readMaturinModuleName(rootDir: string, packageDir: string): string | undefined {
  const file = posix.join(packageDir, 'pyproject.toml');
  let doc: unknown;
  try {
    doc = parseToml(fs.readFileSync(`${rootDir}/${file}`, 'utf8'));
  } catch {
    return undefined;
  }
  const name = (doc as { tool?: { maturin?: { 'module-name'?: unknown } } }).tool?.maturin?.[
    'module-name'
  ];
  return typeof name === 'string' && name.length > 0 ? name : undefined;
}

/** Every function and struct the crate declares, with the Python name it is exported under. */
function membersOf(index: RustCrateIndex): Member[] {
  const members: Member[] = [];
  for (const fn of index.functions) {
    if (fn.container !== null) continue;
    members.push({
      rustName: fn.item.name,
      symbolId: fn.id,
      file: fn.owner.file,
      pythonName: pyNameOf(fn.item.attrs, 'pyfunction') ?? fn.item.name,
      exported: attrNamed(fn.item.attrs, 'pymodule_export') !== undefined,
    });
  }
  for (const decl of index.decls) {
    if (decl.item.kind !== 'struct') continue;
    members.push({
      rustName: decl.item.name,
      symbolId: decl.id,
      file: decl.owner.file,
      pythonName: pyNameOf(decl.item.attrs, 'pyclass') ?? decl.item.name,
      exported: attrNamed(decl.item.attrs, 'pymodule_export') !== undefined,
    });
  }
  return members;
}

function attrNamed(attrs: readonly Attribute[], path: string): Attribute | undefined {
  return attrs.find((attr) => attr.path === path);
}

/** `name = "..."` in an attribute's arguments. */
function nameArgOf(attr: Attribute): string | undefined {
  return /\bname\s*=\s*"([^"]*)"/.exec(attr.raw)?.[1];
}

function pyo3NameOf(attrs: readonly Attribute[]): string | undefined {
  const attr = attrNamed(attrs, 'pyo3');
  return attr === undefined ? undefined : nameArgOf(attr);
}

function pyNameOf(attrs: readonly Attribute[], path: string): string | undefined {
  const attr = attrNamed(attrs, path);
  return attr === undefined ? undefined : nameArgOf(attr);
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf(':') + 1);
}

/** The text of a token group, with one space between tokens. */
function flatten(tree: TokenTree | TokenGroup): string {
  if (!isTokenGroup(tree)) return tree.text;
  const inner = tree.children.map(flatten).join(' ');
  return `${tree.open.text} ${inner} ${tree.close?.text ?? ''}`;
}

/** The crate whose directory holds the file, the longest such directory winning. */
function crateOwning(file: string, crates: readonly Pyo3Crate[]): Pyo3Crate | undefined {
  let best: Pyo3Crate | undefined;
  for (const crate of crates) {
    const dir = posix.normalize(crate.packageDir);
    const inside = dir === '.' || dir === '' || file.startsWith(`${dir}/`);
    if (!inside) continue;
    if (best === undefined || dir.length > posix.normalize(best.packageDir).length) best = crate;
  }
  return best;
}
