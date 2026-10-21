import type { LoadKind, SourceSpan } from '../types.js';
import type { FileFacts } from './types.js';

/**
 * The module-load engine (Phase 2.7, module loads). It reads `load` module-edge facts and returns
 * edge descriptions. A load to a repository file adds an `imports` edge; a load whose specifier is
 * not a constant is an observation. External and unresolved loads add nothing.
 */

/** The detail recorded for a dynamic load. The front end reports the same reason in `ModuleLoad`. */
export const DYNAMIC_SPECIFIER_DETAIL = 'the module specifier is not a constant';

/** What the engine found, to be applied to the graph. */
export type ModuleLoadEdge =
  | {
      readonly kind: 'imports';
      readonly from: string;
      readonly to: string;
      readonly loadKind: LoadKind;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: 'observation';
      readonly from: string;
      readonly subject: string;
      readonly detail: string;
      readonly loadKind: LoadKind;
      readonly span: SourceSpan;
    };

/** Runs the module-load engine over every file's facts, in file order. */
export function runModuleLoadEngine(files: readonly FileFacts[]): ModuleLoadEdge[] {
  const edges: ModuleLoadEdge[] = [];
  for (const file of files) {
    for (const fact of file.facts) {
      if (fact.kind !== 'module-edge' || fact.form !== 'load' || fact.loadKind === undefined) {
        continue;
      }
      const from = fact.owner ?? fact.filePath;
      if (fact.target.kind === 'file') {
        edges.push({
          kind: 'imports',
          from,
          to: fact.target.path,
          loadKind: fact.loadKind,
          span: fact.span,
        });
      } else if (
        fact.target.kind === 'unresolved' &&
        fact.target.reason === 'dynamic-module-specifier'
      ) {
        edges.push({
          kind: 'observation',
          from,
          subject: fact.target.subject,
          detail: DYNAMIC_SPECIFIER_DETAIL,
          loadKind: fact.loadKind,
          span: fact.span,
        });
      }
    }
  }
  return edges;
}
