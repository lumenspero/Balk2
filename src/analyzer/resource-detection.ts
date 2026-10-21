import * as fs from 'fs';
import * as path from 'path';
import type { ConnectionGraph } from '../graph.js';
import { runResourceEngine, type ResourceCatalogEntry } from '../facts/resource-engine.js';
import { applyResourceEdges } from './resource-edges.js';
import { extractResourceFacts } from './resource-facts.js';
import type { RepositoryProgram } from './repository-program.js';
import type { ResourceProtocol } from './resource-protocols.js';

/**
 * Resource detection: templates, stylesheets and schemas that code uses.
 *
 * The TypeScript front end reads imports and configured loader calls as facts
 * (`resource-facts.ts`). The resource engine decides what they link to (`facts/resource-engine.ts`),
 * and `resource-edges.ts` writes the result to the graph.
 *
 * A path that names no file inside the repository is silent, the same rule external modules
 * follow. The check is against the disk under the repository root, because the TypeScript program
 * holds only code files.
 */
export function collectResourceRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  protocols: readonly ResourceProtocol[],
): void {
  const catalog = protocols.map((protocol): ResourceCatalogEntry => ({
    function: protocol.function,
    specifierArg: protocol.specifierArg,
    languages: ['javascript', 'typescript'],
  }));
  const edges = runResourceEngine({
    files: extractResourceFacts(repository, protocols),
    catalog,
    fileExists: (repoPath) => isFile(repository.rootDir, repoPath),
  });
  applyResourceEdges(graph, edges);
}

function isFile(rootDir: string, repoPath: string): boolean {
  const absolute = path.join(rootDir, ...repoPath.split('/'));
  return fs.existsSync(absolute) && fs.statSync(absolute).isFile();
}
