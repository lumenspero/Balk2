import * as nodePath from 'node:path';
import { detectResourceKind } from '../data/formats.js';
import { normalizePath } from '../graph.js';
import type { Confidence, Evidence, ResourceKind, SourceSpan } from '../types.js';
import { entriesFor, type CatalogEntry } from './engine.js';
import { joinPathParts, resolveRepoPath, type PathPart } from './path-value.js';
import type { CallSite, FileFacts, ModuleEdge } from './types.js';

/**
 * The resource engine (Phase 2.7, first family). It reads module-edge and call facts and returns
 * edge descriptions. It never touches the graph or the disk: `fileExists` is injected.
 *
 * - A relative static import of a resource file links the importing file with `mechanism: 'import'`.
 *   A bare specifier is a package and is ignored.
 * - A configured loader call links its owner to the resource its path argument names, with
 *   `mechanism: 'loader'`. A relative path resolves from the calling file, otherwise from the root.
 * - A loader path that is not a constant is an observation.
 */

/** A configured loader, as the engine reads it. */
export interface ResourceCatalogEntry extends CatalogEntry {
  readonly function: string;
  readonly specifierArg: number;
}

/** Facts and catalog for one run of the engine. */
export interface ResourceEngineInput {
  readonly files: readonly FileFacts[];
  readonly catalog: readonly ResourceCatalogEntry[];
  /** True when a repository-relative path is an existing file. */
  readonly fileExists: (repoPath: string) => boolean;
}

/** What the engine found, to be applied to the graph. */
export type ResourceEdge =
  | {
      readonly kind: 'uses';
      readonly from: string;
      readonly resourcePath: string;
      readonly resourceKind: ResourceKind;
      readonly mechanism: 'import' | 'loader';
      readonly confidence: Confidence;
      readonly evidence: Evidence;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: 'observation';
      readonly from: string;
      readonly subject: string;
      readonly detail: string;
      readonly span: SourceSpan;
    };

/** Runs the resource engine over every file's facts, in file order. */
export function runResourceEngine(input: ResourceEngineInput): ResourceEdge[] {
  const edges: ResourceEdge[] = [];
  for (const file of input.files) {
    const byName = new Map(
      entriesFor(input.catalog, file.language).map((entry) => [entry.function, entry] as const),
    );
    for (const fact of file.facts) {
      let edge: ResourceEdge | undefined;
      if (fact.kind === 'module-edge') {
        edge = importEdge(fact, input);
      } else if (fact.kind === 'call' && byName.size > 0) {
        edge = loaderEdge(fact, byName, input);
      }
      if (edge !== undefined) edges.push(edge);
    }
  }
  return edges;
}

function importEdge(fact: ModuleEdge, input: ResourceEngineInput): ResourceEdge | undefined {
  if (fact.form !== 'import') return undefined;
  const resource = resolveResource(fact.specifier, fact.filePath, 'import', input);
  if (resource === undefined) return undefined;
  return {
    kind: 'uses',
    from: fact.filePath,
    resourcePath: resource.path,
    resourceKind: resource.kind,
    mechanism: 'import',
    confidence: 'high',
    evidence: 'ast',
    span: fact.span,
  };
}

function loaderEdge(
  call: CallSite,
  byName: ReadonlyMap<string, ResourceCatalogEntry>,
  input: ResourceEngineInput,
): ResourceEdge | undefined {
  if (call.name === undefined) return undefined;
  const entry = byName.get(call.name);
  if (entry === undefined) return undefined;
  const arg = call.positional[entry.specifierArg];
  if (arg === undefined) return undefined;

  const from = call.owner ?? call.filePath;
  if (arg.kind === 'dynamic') {
    return {
      kind: 'observation',
      from,
      subject: call.text ?? '',
      detail: arg.reason,
      span: call.span,
    };
  }
  if (arg.kind !== 'string') return undefined;

  const resource = resolveResource(arg.value, call.filePath, 'loader', input);
  if (resource === undefined) return undefined;
  return {
    kind: 'uses',
    from,
    resourcePath: resource.path,
    resourceKind: resource.kind,
    mechanism: 'loader',
    confidence: 'high',
    evidence: 'config',
    span: call.span,
  };
}

/**
 * The resource a specifier names, or undefined. A relative path resolves from the calling file;
 * without a leading dot it resolves from the repository root. A query suffix is ignored. The path
 * must stay inside the repository, have a resource kind, and exist.
 */
function resolveResource(
  specifier: string,
  fromFile: string,
  mode: 'import' | 'loader',
  input: ResourceEngineInput,
): { readonly path: string; readonly kind: ResourceKind } | undefined {
  const bare = stripQuery(specifier);
  const isRelative = bare.startsWith('.');
  if (mode === 'import' && !isRelative) return undefined;

  const parts: PathPart[] = isRelative
    ? [
        { kind: 'anchor', anchor: 'file-dir' },
        { kind: 'literal', text: bare },
      ]
    : [{ kind: 'literal', text: bare }];
  const repoPath = resolveRepoPath(joinPathParts(parts), { fileDir: directoryOf(fromFile) });
  if (repoPath === undefined) return undefined;

  const kind = detectResourceKind(repoPath);
  if (kind === undefined || !input.fileExists(repoPath)) return undefined;
  return { path: normalizePath(repoPath), kind };
}

function directoryOf(filePath: string): string {
  const directory = nodePath.posix.dirname(normalizePath(filePath));
  return directory === '.' ? '' : directory;
}

function stripQuery(specifier: string): string {
  const query = specifier.indexOf('?');
  return query < 0 ? specifier : specifier.slice(0, query);
}
