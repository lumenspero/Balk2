/**
 * Build scripts (V3 Phase 10.5).
 *
 * A build script (`build.rs`) prints `cargo:rerun-if-changed=PATH`, or `cargo::rerun-if-changed=PATH`,
 * to tell Cargo which files it reads. Cargo runs the script from the package directory, so each path is
 * relative to it. The function that prints the line gets a `reads` edge to the file. A path with a
 * format placeholder is dynamic, and a path that names no file in the repository is unresolved.
 */
import { detectArtifactFormat } from '../../../data/formats.js';
import { joinPathParts, resolveRepoPath } from '../../../facts/path-value.js';
import type { ArtifactFormat, UnresolvedReason } from '../../../types.js';
import { scanFunctionBody } from '../body.js';
import type { Span } from '../items.js';
import type { TokenGroup } from '../token-tree.js';
import { literalOf, splitAtCommas } from './includes.js';
import type { RustCrateIndex } from './module-index.js';

/** A crate of the repository, with its package directory and whether it is a build script. */
export interface BuildScriptCrate {
  readonly index: RustCrateIndex;
  readonly packageDir: string | undefined;
  readonly buildScript: boolean;
}

export type BuildScriptEdge =
  | {
      readonly kind: 'reads';
      /** The function that prints the rerun line. */
      readonly from: string;
      readonly artifactPath: string;
      readonly format: ArtifactFormat;
      readonly file: string;
      readonly span: Span;
    }
  | {
      readonly kind: 'observation';
      readonly from: string;
      readonly reason: UnresolvedReason;
      readonly subject: string;
      readonly detail: string;
      readonly file: string;
      readonly span: Span;
    };

const RERUN_PREFIXES: readonly string[] = [
  'cargo:rerun-if-changed=',
  'cargo::rerun-if-changed=',
];
const PRINT_MACROS: ReadonlySet<string> = new Set(['println', 'print']);

/** Every `rerun-if-changed` line a build script prints, as the files it reads. */
export function bindBuildScripts(
  crates: readonly BuildScriptCrate[],
  files: ReadonlySet<string>,
): BuildScriptEdge[] {
  const edges: BuildScriptEdge[] = [];
  for (const crate of crates) {
    if (!crate.buildScript) continue;
    for (const fn of crate.index.functions) {
      const body = fn.item.body;
      if (body === null) continue;
      for (const fact of scanFunctionBody(body)) {
        if (fact.kind !== 'macro-call') continue;
        const name = fact.path[fact.path.length - 1] ?? '';
        if (!PRINT_MACROS.has(name)) continue;
        const edge = rerunEdge(fact.args, fn.id, fn.owner.file, crate.packageDir, files, fact.span);
        if (edge !== undefined) edges.push(edge);
      }
    }
  }
  return edges;
}

function rerunEdge(
  args: TokenGroup,
  from: string,
  file: string,
  packageDir: string | undefined,
  files: ReadonlySet<string>,
  span: Span,
): BuildScriptEdge | undefined {
  const [first = []] = splitAtCommas(args.children);
  const text = first.length === 1 ? literalOf(first[0]) : undefined;
  const prefix = RERUN_PREFIXES.find((candidate) => text?.startsWith(candidate) === true);
  if (text === undefined || prefix === undefined) return undefined;

  const rest = text.slice(prefix.length);
  const subject = `rerun-if-changed=${rest}`;
  if (rest.includes('{')) {
    return {
      kind: 'observation',
      from,
      reason: 'dynamic-include-path',
      subject,
      detail: 'rerun-if-changed names a path with a format placeholder',
      file,
      span,
    };
  }

  const value = joinPathParts([
    { kind: 'anchor', anchor: 'package-dir' },
    { kind: 'literal', text: rest },
  ]);
  const target = packageDir === undefined ? undefined : resolveRepoPath(value, { fileDir: '', packageDir });
  if (target === undefined || !files.has(target)) {
    return {
      kind: 'observation',
      from,
      reason: 'unresolved-module-path',
      subject,
      detail: 'rerun-if-changed names no file in the repository',
      file,
      span,
    };
  }
  return {
    kind: 'reads',
    from,
    artifactPath: target,
    format: detectArtifactFormat(target) ?? 'unknown',
    file,
    span,
  };
}
