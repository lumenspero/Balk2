import type { ConnectionGraph } from '../graph.js';
import { runMetadataEngine, type MetadataCatalogEntry } from '../facts/metadata-engine.js';
import { applyMetadataEdges } from './metadata-apply.js';
import { extractMetadataFacts } from './metadata-facts.js';
import type { MetadataProtocol } from './metadata-protocols.js';
import type { RepositoryProgram } from './repository-program.js';

/**
 * Reflect metadata with a configured key. A define links the target symbol to the metadata key
 * (`definesMetadata`); a read links the enclosing owner to it (`readsMetadata`).
 *
 * The TypeScript front end reads each `Reflect` call as a fact (`metadata-facts.ts`). The metadata
 * engine decides what links to what (`facts/metadata-engine.ts`), and `metadata-apply.ts` writes
 * the result to the graph.
 *
 * - A key that is not configured is ignored, so unrelated `Reflect` calls stay silent.
 * - A key that is not a constant, or a target that is not a top-level declaration or class member,
 *   is an `unresolved-metadata-key` observation linked from the owner at low confidence.
 * - Only direct calls on the global `Reflect` name are read.
 */
export function collectMetadataRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  protocols: readonly MetadataProtocol[],
): void {
  if (protocols.length === 0) return;

  const catalog = protocols.map((protocol): MetadataCatalogEntry => ({
    ...protocol,
    languages: ['javascript', 'typescript'],
  }));
  const edges = runMetadataEngine({
    files: extractMetadataFacts(repository, graph),
    catalog,
  });
  applyMetadataEdges(graph, edges);
}
