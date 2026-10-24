import type { Evidence, SourceSpan } from '../types.js';
import { entriesFor, type CatalogEntry } from './engine.js';
import type { ArgValue, CallSite, FileFacts } from './types.js';

/**
 * The callback engine (Phase 2.7, callbacks). It reads call facts whose callback argument is
 * classified, and returns edge descriptions. A callback is passed, not invoked, so no `calls` edge
 * is drawn for it.
 */

/** Detail recorded for a callback no repository declaration can name. */
export const UNRESOLVED_CALLBACK_DETAIL =
  'the callback is not a function or value declared at the top level of a repository file';

/** A configured callback-receiving function, as the engine reads it. */
export interface CallbackCatalogEntry extends CatalogEntry {
  readonly function: string;
  /** Zero-based argument position that holds the callback */
  readonly callbackArg?: number;
  /** The keyword argument that holds the callback, for a library that takes it by name */
  readonly keyword?: string;
}

/** The argument of a call that the catalog entry names as its callback. */
function callbackArgOf(fact: CallSite, entry: CallbackCatalogEntry): ArgValue | undefined {
  if (entry.keyword !== undefined) return fact.keyword[entry.keyword];
  if (entry.callbackArg !== undefined) return fact.positional[entry.callbackArg];
  return undefined;
}

/** What the engine found, to be applied to the graph. */
export type CallbackEdge =
  | {
      readonly kind: 'passes';
      readonly from: string;
      readonly to: string;
      readonly inline: boolean;
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

/** Runs the callback engine over every file's facts, in file order. */
export function runCallbackEngine(input: {
  readonly files: readonly FileFacts[];
  readonly catalog: readonly CallbackCatalogEntry[];
}): CallbackEdge[] {
  const edges: CallbackEdge[] = [];
  for (const file of input.files) {
    const byName = new Map(
      entriesFor(input.catalog, file.language).map((entry) => [entry.function, entry] as const),
    );
    if (byName.size === 0) continue;

    for (const fact of file.facts) {
      if (fact.kind !== 'call' || fact.name === undefined) continue;
      const entry = byName.get(fact.name);
      if (entry === undefined) continue;
      const argument = callbackArgOf(fact, entry);
      if (argument === undefined || argument.kind !== 'callback') continue;

      const from = fact.owner ?? fact.filePath;
      const { resolution, span } = argument;
      if (resolution.kind === 'inline') {
        edges.push({ kind: 'passes', from, to: from, inline: true, evidence: 'ast', span });
      } else if (resolution.kind === 'symbol') {
        edges.push({
          kind: 'passes',
          from,
          to: resolution.id,
          inline: false,
          evidence: 'ts-program',
          span,
        });
      } else if (resolution.kind === 'unresolved') {
        edges.push({
          kind: 'observation',
          from,
          subject: resolution.subject,
          detail: UNRESOLVED_CALLBACK_DETAIL,
          span,
        });
      }
    }
  }
  return edges;
}
