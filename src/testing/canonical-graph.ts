import type { ConnectionMap } from '../types.js';

const NODE_TABLES = [
  'files',
  'symbols',
  'artifacts',
  'eventChannels',
  'registryKeys',
  'metadataKeys',
  'resources',
  'statePaths',
  'unresolved',
] as const;

/**
 * A stable text form of a whole connection map: every node id by table, then every relationship
 * with its confidence. Generation metadata is left out, so the text depends only on the analysis.
 */
export function canonicalGraph(map: ConnectionMap): string {
  const out: string[] = [];

  for (const table of NODE_TABLES) {
    out.push(`# nodes: ${table}`);
    for (const id of Object.keys(map[table]).sort()) out.push(id);
  }

  out.push('# relationships');
  const relationships = map.relationships
    .map((rel) => `${rel.type} ${rel.from} -> ${rel.to} [${rel.confidence}]`)
    .sort();
  out.push(...relationships);

  return `${out.join('\n')}\n`;
}
