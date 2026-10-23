import { lexRust } from './lexer.js';
import { constantsIn, moduleBlocks, type ModulePosition } from './data-apis.js';
import { buildTokenTrees, type TokenTree } from './token-tree.js';

/**
 * The module tree of a Rust crate (V3 Phase 11.6). A module is a file, or an inline `mod` inside one.
 * A path such as `crate::a::b`, `super::b` or `self::b` resolves from the module it is written in,
 * following Rust's rules: a file module's children live beside it, in a directory named for it, or
 * in `mod.rs` for a module that is a directory. The parent of a file module is the module that
 * declares it, found by searching the crate's files.
 */

/** What the tree reads from the repository. */
export interface ModuleTreeHost {
  /** The repository's Rust files. */
  readonly files: readonly string[];
  /** The text of a repository file, or undefined. */
  readonly source: (file: string) => string | undefined;
  /** The crate root file (`lib.rs` or `main.rs`) of the crate a file belongs to, or undefined. */
  readonly crateRoot: (file: string) => string | undefined;
  readonly exists: (file: string) => boolean;
}

export class RustModuleTree {
  private readonly trees = new Map<string, readonly TokenTree[] | null>();

  constructor(private readonly host: ModuleTreeHost) {}

  /** The module a path names, from the module it is written in. Undefined when none is. */
  resolve(segments: readonly string[], from: ModulePosition): ModulePosition | undefined {
    let current: ModulePosition | undefined = from;
    for (const [i, segment] of segments.entries()) {
      if (current === undefined) return undefined;
      if (segment === 'crate' && i === 0) {
        const root = this.host.crateRoot(from.file);
        current = root === undefined ? undefined : { file: root, inline: [] };
      } else if (segment === 'self') {
        continue;
      } else if (segment === 'super') {
        current = this.parentOf(current);
      } else {
        current = this.child(current, segment);
      }
    }
    return current;
  }

  /** The constant a module declares under a name, or undefined. */
  constantAt(module: ModulePosition, name: string): string | undefined {
    const block = this.blockAt(module);
    return block === undefined ? undefined : constantsIn(block).get(name);
  }

  /** The token trees of a module's body, or undefined when the file or the inline module is not there. */
  private blockAt(module: ModulePosition): readonly TokenTree[] | undefined {
    let block = this.treesOf(module.file);
    for (const name of module.inline) {
      if (block === undefined) return undefined;
      block = moduleBlocks(block).inline.get(name);
    }
    return block;
  }

  private treesOf(file: string): readonly TokenTree[] | undefined {
    const cached = this.trees.get(file);
    if (cached !== undefined) return cached ?? undefined;
    const source = this.host.source(file);
    const parsed = source === undefined ? null : buildTokenTrees(lexRust(source).tokens).trees;
    this.trees.set(file, parsed);
    return parsed ?? undefined;
  }

  private child(module: ModulePosition, name: string): ModulePosition | undefined {
    const block = this.blockAt(module);
    if (block !== undefined && moduleBlocks(block).inline.has(name)) {
      return { file: module.file, inline: [...module.inline, name] };
    }
    const file = this.childFile(module, name);
    return file === undefined ? undefined : { file, inline: [] };
  }

  /** The file a file module declares, beside its parent module, or undefined. */
  private childFile(module: ModulePosition, name: string): string | undefined {
    const dir = moduleDirOf(module);
    const base = dir === '' ? name : `${dir}/${name}`;
    return [`${base}.rs`, `${base}/mod.rs`].find((candidate) => this.host.exists(candidate));
  }

  /** The module that declares this one. Undefined for a crate root, which has no parent. */
  private parentOf(module: ModulePosition): ModulePosition | undefined {
    if (module.inline.length > 0) {
      return { file: module.file, inline: module.inline.slice(0, -1) };
    }
    for (const file of this.host.files) {
      for (const position of this.modulesIn(file)) {
        const block = this.blockAt(position);
        if (block === undefined) continue;
        for (const name of moduleBlocks(block).files) {
          if (this.childFile(position, name) === module.file) return position;
        }
      }
    }
    return undefined;
  }

  /** Every module a file holds, its own and its inline modules, outermost first. */
  private modulesIn(file: string): ModulePosition[] {
    const out: ModulePosition[] = [];
    const visit = (position: ModulePosition): void => {
      out.push(position);
      const block = this.blockAt(position);
      if (block === undefined) return;
      for (const name of moduleBlocks(block).inline.keys()) {
        visit({ file, inline: [...position.inline, name] });
      }
    };
    visit({ file, inline: [] });
    return out;
  }
}

/** The directory a module's children live in: the file's directory, or the file's own directory. */
function moduleDirOf(module: ModulePosition): string {
  const slash = module.file.lastIndexOf('/');
  const dir = slash < 0 ? '' : module.file.slice(0, slash);
  const name = module.file.slice(slash + 1);
  const own = ['lib.rs', 'main.rs', 'mod.rs'].includes(name)
    ? dir
    : [dir, name.replace(/\.rs$/, '')].filter((part) => part !== '').join('/');
  return [own, ...module.inline].filter((part) => part !== '').join('/');
}
