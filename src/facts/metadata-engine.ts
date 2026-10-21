import type { SourceSpan } from '../types.js';
import { entriesFor, type CatalogEntry } from './engine.js';
import type { FileFacts } from './types.js';

/**
 * The metadata engine (Phase 2.7, metadata). It reads `Reflect` call facts and returns edge
 * descriptions. A define links the target symbol to a configured key; a read links the owner to
 * it. A key that is not constant, or a target with no symbol, is an observation.
 */

/** The `Reflect` calls that store metadata. The third argument is the target. */
export const METADATA_DEFINE_METHODS: readonly string[] = ['defineMetadata', 'defineOwnMetadata'];

/** The `Reflect` calls that read metadata. The second argument is the target. */
export const METADATA_READ_METHODS: readonly string[] = [
  'getMetadata',
  'getOwnMetadata',
  'hasMetadata',
  'hasOwnMetadata',
];

/** Detail recorded when a target is not a top-level declaration or class member. */
export const UNRESOLVED_TARGET_DETAIL =
  'the target is not a top-level declaration or class member, so it has no symbol';

/** A configured metadata key, as the engine reads it. */
export interface MetadataCatalogEntry extends CatalogEntry {
  readonly key: string;
  readonly defines?: boolean;
  readonly reads?: boolean;
}

/** What the engine found, to be applied to the graph. */
export type MetadataEdge =
  | {
      readonly kind: 'defines';
      readonly target: string;
      readonly key: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: 'reads';
      readonly from: string;
      readonly key: string;
      readonly span: SourceSpan;
    }
  | {
      readonly kind: 'observation';
      readonly attempted: 'definesMetadata' | 'readsMetadata';
      readonly from: string;
      readonly subject: string;
      readonly detail: string;
      readonly span: SourceSpan;
    };

/** Runs the metadata engine over every file's facts, in file order. */
export function runMetadataEngine(input: {
  readonly files: readonly FileFacts[];
  readonly catalog: readonly MetadataCatalogEntry[];
}): MetadataEdge[] {
  const edges: MetadataEdge[] = [];
  for (const file of input.files) {
    const byKey = new Map(
      entriesFor(input.catalog, file.language).map((entry) => [entry.key, entry] as const),
    );
    if (byKey.size === 0) continue;

    for (const fact of file.facts) {
      if (fact.kind !== 'call' || fact.name === undefined) continue;
      const isDefine = METADATA_DEFINE_METHODS.includes(fact.name);
      const isRead = METADATA_READ_METHODS.includes(fact.name);
      if (!isDefine && !isRead) continue;

      const keyArg = fact.positional[0];
      const targetArg = fact.positional[isDefine ? 2 : 1];
      if (keyArg === undefined || targetArg === undefined) continue;

      const from = fact.owner ?? fact.filePath;
      const attempted = isDefine ? 'definesMetadata' : 'readsMetadata';
      const observe = (detail: string): void => {
        edges.push({
          kind: 'observation',
          attempted,
          from,
          subject: fact.text ?? '',
          detail,
          span: fact.span,
        });
      };

      if (keyArg.kind === 'not-a-name') continue;
      if (keyArg.kind === 'dynamic') {
        observe(keyArg.reason);
        continue;
      }
      if (keyArg.kind !== 'string') continue;

      const protocol = byKey.get(keyArg.value);
      if (protocol === undefined) continue;
      if (isDefine ? protocol.defines !== true : protocol.reads !== true) continue;

      if (targetArg.kind !== 'symbol') {
        observe(UNRESOLVED_TARGET_DETAIL);
        continue;
      }
      if (isDefine) {
        edges.push({ kind: 'defines', target: targetArg.id, key: keyArg.value, span: fact.span });
      } else {
        edges.push({ kind: 'reads', from, key: keyArg.value, span: fact.span });
      }
    }
  }
  return edges;
}
