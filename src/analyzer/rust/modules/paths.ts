import { posix } from 'node:path';

/** An inline `mod name { }` block that encloses a declaration (V3 Phase 8.1–8.2). */
export interface InlineModule {
  readonly name: string;
  /** The value of its `#[path = "..."]` attribute, or null */
  readonly pathAttr: string | null;
}

/** A `mod name;` declaration whose child file has to be found. */
export interface ModDeclaration {
  /** Repository-relative path of the file that holds the declaration, with `/` separators */
  readonly file: string;
  /** Whether that file is mod-rs (see `isModRsFile`) */
  readonly modRs: boolean;
  /** The enclosing inline modules, outermost first */
  readonly inlineModules: readonly InlineModule[];
  /** The value of `#[path = "..."]` on the declaration, or null */
  readonly pathAttr: string | null;
  readonly name: string;
}

/**
 * Whether a file is mod-rs, so that its child modules sit in its own directory: a crate root, a
 * file named `mod.rs`, or a file loaded through a `#[path]` attribute. rustc treats every
 * `#[path]` file as `mod.rs` (`DirOwnership::Owned { relative: None }` in `rustc_expand`).
 * Every other module file is non-mod-rs, and its children sit in a directory named after it.
 */
export function isModRsFile(
  file: string,
  options: { readonly crateRoot: boolean; readonly loadedByPath: boolean },
): boolean {
  return options.crateRoot || options.loadedByPath || posix.basename(file) === 'mod.rs';
}

function normalizePathAttr(value: string): string {
  return value.replace(/\\/g, '/');
}

/**
 * The directory the enclosing inline modules resolve to. `null` outside any inline module.
 * `undefined` when an absolute `#[path]` leaves the repository, which the map cannot name.
 *
 * A `#[path]` on an inline module is relative to the source file's directory when the module is
 * outermost, and to the enclosing inline directory otherwise (Rust Reference, "The path attribute").
 */
function inlineDirectory(
  modules: readonly InlineModule[],
  fileDir: string,
  moduleDir: string,
): string | null | undefined {
  let dir: string | null = null;
  for (const module of modules) {
    const parent = dir ?? (module.pathAttr === null ? moduleDir : fileDir);
    if (module.pathAttr === null) {
      dir = posix.join(parent, module.name);
      continue;
    }
    const target = normalizePathAttr(module.pathAttr);
    if (posix.isAbsolute(target)) return undefined;
    dir = posix.join(parent, target);
  }
  return dir;
}

/**
 * The repository-relative files a `mod` declaration may load, in precedence order. Empty when the
 * module cannot be placed inside the repository.
 *
 * Without `#[path]`, the candidates are `<dir>/name.rs` and `<dir>/name/mod.rs`. `<dir>` is the
 * file's directory for a mod-rs file, or the file's directory plus its stem for a non-mod-rs file,
 * then extended by the enclosing inline modules.
 *
 * With `#[path]`, there is one candidate. Outside inline modules it is relative to the declaring
 * file's directory. Inside them it is relative to the innermost inline directory.
 *
 * Rust Reference, "Module source filenames" and "The path attribute".
 */
export function moduleFileCandidates(declaration: ModDeclaration): string[] {
  const fileDir = posix.dirname(declaration.file);
  const stem = posix.basename(declaration.file, '.rs');
  const moduleDir = declaration.modRs ? fileDir : posix.join(fileDir, stem);
  const inline = inlineDirectory(declaration.inlineModules, fileDir, moduleDir);
  if (inline === undefined) return [];

  if (declaration.pathAttr !== null) {
    const target = normalizePathAttr(declaration.pathAttr);
    if (posix.isAbsolute(target)) return [];
    return [posix.join(inline ?? fileDir, target)];
  }

  const dir = inline ?? moduleDir;
  return [posix.join(dir, `${declaration.name}.rs`), posix.join(dir, declaration.name, 'mod.rs')];
}
