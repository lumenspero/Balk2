import type { ConnectionMap, Relationship } from '../types.js';
import { findConnectionPaths, type PathFinderOptions } from './path-finder.js';

export interface MarkdownOptions {
  /** Options for connection path generation */
  readonly pathOptions?: PathFinderOptions;
}

/**
 * Render a canonical ConnectionMap object into human-readable Markdown format.
 *
 * Output is deterministic: keys, sections, and items are sorted alphabetically.
 */
export function renderMarkdown(map: ConnectionMap, options?: MarkdownOptions): string {
  const lines: string[] = [];

  // 1. Header
  lines.push('# Repository Connection Map');
  lines.push('');
  lines.push(`Generated: ${map.repository.generatedAt}`);
  if (map.repository.commit) {
    lines.push(`Commit: ${map.repository.commit}`);
  }
  lines.push('');

  // 2. Repository Overview
  const fileCount = Object.keys(map.files).length;
  const symbolCount = Object.keys(map.symbols).length;
  const artifactCount = Object.keys(map.artifacts).length;
  const relationshipCount = map.relationships.length;

  lines.push('## Repository Overview');
  lines.push('');
  lines.push(`- **Files**: ${fileCount}`);
  lines.push(`- **Symbols**: ${symbolCount}`);
  lines.push(`- **Data Artifacts**: ${artifactCount}`);
  lines.push(`- **Relationships**: ${relationshipCount}`);
  lines.push('');

  // Index relationships for quick lookup
  const outgoingMap = new Map<string, Relationship[]>();
  const incomingMap = new Map<string, Relationship[]>();

  for (const rel of map.relationships) {
    if (!outgoingMap.has(rel.from)) outgoingMap.set(rel.from, []);
    outgoingMap.get(rel.from)?.push(rel);

    if (!incomingMap.has(rel.to)) incomingMap.set(rel.to, []);
    incomingMap.get(rel.to)?.push(rel);
  }

  // 3. File Connections
  const files = Object.keys(map.files).sort();
  if (files.length > 0) {
    lines.push('## File Connections');
    lines.push('');

    for (const filePath of files) {
      const fileNode = map.files[filePath];
      const langSuffix = fileNode?.language ? ` (${fileNode.language})` : '';
      lines.push(`### ${filePath}${langSuffix}`);
      lines.push('');

      const outRels = outgoingMap.get(filePath) ?? [];
      const inRels = incomingMap.get(filePath) ?? [];

      const imports = outRels
        .filter((r) => r.type === 'imports')
        .map((r) => r.to)
        .sort();
      const importedBy = reverseSources(inRels, outRels, 'imports', 'importedBy');
      const references = targetsOf(outRels, 'references');
      const referencedBy = sourcesOf(inRels, 'references');

      if (imports.length > 0) {
        lines.push('Imports:');
        for (const imp of dedupe(imports)) {
          lines.push(`  → ${imp}`);
        }
      }

      if (importedBy.length > 0) {
        lines.push('Imported by:');
        for (const impBy of dedupe(importedBy)) {
          lines.push(`  ← ${impBy}`);
        }
      }

      if (imports.length === 0 && importedBy.length === 0) {
        lines.push('*(No direct file imports)*');
      }

      if (references.length > 0) {
        lines.push('References:');
        for (const target of dedupe(references)) {
          lines.push(`  → ${target}`);
        }
      }

      if (referencedBy.length > 0) {
        lines.push('Referenced by:');
        for (const source of dedupe(referencedBy)) {
          lines.push(`  ← ${source}`);
        }
      }

      lines.push('');
    }
  }

  // 4. Symbol Connections
  const symbolKeySet = new Set(Object.keys(map.symbols));
  for (const rel of map.relationships) {
    if (rel.from.includes(':')) symbolKeySet.add(rel.from);
    if (rel.to.includes(':')) symbolKeySet.add(rel.to);
  }
  const symbols = Array.from(symbolKeySet).sort();

  if (symbols.length > 0) {
    lines.push('## Symbol Connections');
    lines.push('');

    for (const symId of symbols) {
      const symNode = map.symbols[symId];
      const typeSuffix = symNode?.symbolType ? ` [${symNode.symbolType}]` : '';
      lines.push(`### ${symId}${typeSuffix}`);
      lines.push('');

      const outRels = outgoingMap.get(symId) ?? [];
      const inRels = incomingMap.get(symId) ?? [];

      const calls = outRels
        .filter((r) => r.type === 'calls')
        .map((r) => r.to)
        .sort();
      const calledBy = reverseSources(inRels, outRels, 'calls', 'calledBy');
      const symbolReferences = targetsOf(outRels, 'references');
      const symbolReferencedBy = sourcesOf(inRels, 'references');
      const extendsRels = outRels
        .filter((r) => r.type === 'extends')
        .map((r) => r.to)
        .sort();
      const implementsRels = outRels
        .filter((r) => r.type === 'implements')
        .map((r) => r.to)
        .sort();

      if (extendsRels.length > 0) {
        lines.push('Extends:');
        for (const target of dedupe(extendsRels)) {
          lines.push(`  → ${target}`);
        }
      }

      if (implementsRels.length > 0) {
        lines.push('Implements:');
        for (const target of dedupe(implementsRels)) {
          lines.push(`  → ${target}`);
        }
      }

      if (calls.length > 0) {
        lines.push('Calls:');
        for (const target of dedupe(calls)) {
          lines.push(`  → ${target}`);
        }
      }

      if (calledBy.length > 0) {
        lines.push('Called by:');
        for (const caller of dedupe(calledBy)) {
          lines.push(`  ← ${caller}`);
        }
      }

      if (symbolReferences.length > 0) {
        lines.push('References:');
        for (const target of dedupe(symbolReferences)) {
          lines.push(`  → ${target}`);
        }
      }

      if (symbolReferencedBy.length > 0) {
        lines.push('Referenced by:');
        for (const source of dedupe(symbolReferencedBy)) {
          lines.push(`  ← ${source}`);
        }
      }

      lines.push('');
    }
  }

  // 5. Data Connections
  const artifacts = Object.keys(map.artifacts).sort();
  if (artifacts.length > 0) {
    lines.push('## Data Connections');
    lines.push('');

    for (const artPath of artifacts) {
      const artNode = map.artifacts[artPath];
      const formatSuffix = artNode?.format ? ` (${artNode.format})` : '';
      lines.push(`### ${artPath}${formatSuffix}`);
      lines.push('');

      const outRels = outgoingMap.get(artPath) ?? [];
      const inRels = incomingMap.get(artPath) ?? [];

      const generatedBy = inRels
        .filter((r) => r.type === 'generates' || r.type === 'generatedBy')
        .map((r) => r.from)
        .sort();
      const consumedBy = inRels
        .filter((r) => r.type === 'consumes' || r.type === 'consumedBy')
        .map((r) => r.from)
        .sort();
      const readBy = inRels
        .filter((r) => r.type === 'reads')
        .map((r) => r.from)
        .sort();
      const generatesOut = outRels
        .filter((r) => r.type === 'generates')
        .map((r) => r.to)
        .sort();
      const consumesOut = outRels
        .filter((r) => r.type === 'consumes')
        .map((r) => r.to)
        .sort();

      if (generatedBy.length > 0) {
        lines.push('Generated by:');
        for (const gen of dedupe(generatedBy)) {
          lines.push(`  ← ${gen}`);
        }
      }

      if (generatesOut.length > 0) {
        lines.push('Generates:');
        for (const gen of dedupe(generatesOut)) {
          lines.push(`  → ${gen}`);
        }
      }

      if (consumedBy.length > 0) {
        lines.push('Consumed by:');
        for (const con of dedupe(consumedBy)) {
          lines.push(`  → ${con}`);
        }
      }

      if (consumesOut.length > 0) {
        lines.push('Consumes:');
        for (const con of dedupe(consumesOut)) {
          lines.push(`  ← ${con}`);
        }
      }

      if (readBy.length > 0) {
        lines.push('Read by:');
        for (const rb of dedupe(readBy)) {
          lines.push(`  → ${rb}`);
        }
      }

      lines.push('');
    }
  }

  // 6. Connection Paths
  const paths = findConnectionPaths(map, options?.pathOptions);
  if (paths.length > 0) {
    lines.push('## Connection Paths');
    lines.push('');

    for (const pathItem of paths) {
      lines.push(`### ${pathItem.target}`);
      lines.push('');
      for (const step of pathItem.steps) {
        lines.push(`  ${step}`);
      }
      lines.push('');
    }
  }

  // 7. Footer
  lines.push('## Machine-Readable Graph');
  lines.push('');
  lines.push('See connection-map.json.');
  lines.push('');

  return lines.join('\n');
}

/** Sorted targets of a node's outgoing relationships of one type. */
function targetsOf(outgoing: readonly Relationship[], type: Relationship['type']): string[] {
  return outgoing
    .filter((r) => r.type === type)
    .map((r) => r.to)
    .sort();
}

/** Sorted sources of a node's incoming relationships of one type. */
function sourcesOf(incoming: readonly Relationship[], type: Relationship['type']): string[] {
  return incoming
    .filter((r) => r.type === type)
    .map((r) => r.from)
    .sort();
}

/**
 * Nodes on the other side of a forward relationship (`calls`, `imports`), seen from its
 * target. The stored reverse type (`calledBy`, `importedBy`) points from the target back
 * to the source, so it is read from the node's *outgoing* edges.
 */
function reverseSources(
  incoming: readonly Relationship[],
  outgoing: readonly Relationship[],
  forward: Relationship['type'],
  reverse: Relationship['type'],
): string[] {
  return [...sourcesOf(incoming, forward), ...targetsOf(outgoing, reverse)].sort();
}

function dedupe(items: readonly string[]): string[] {
  return Array.from(new Set(items));
}
