import { forwardRelationships } from '../graph-queries.js';
import type { ConnectionMap, EventRelationship, Relationship } from '../types.js';
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
  // Read the canonical relationships, so the output is the same whether or not a map stores reverse links.
  const relationships = forwardRelationships(map);
  const relationshipCount = relationships.length;
  const channelCount = Object.keys(map.eventChannels).length;
  const unresolvedCount = Object.keys(map.unresolved).length;

  lines.push('## Repository Overview');
  lines.push('');
  lines.push(`- **Files**: ${fileCount}`);
  lines.push(`- **Symbols**: ${symbolCount}`);
  lines.push(`- **Data Artifacts**: ${artifactCount}`);
  if (channelCount > 0) lines.push(`- **Event Channels**: ${channelCount}`);
  if (unresolvedCount > 0) lines.push(`- **Unresolved Observations**: ${unresolvedCount}`);
  lines.push(`- **Relationships**: ${relationshipCount}`);
  lines.push('');

  // Index relationships for quick lookup
  const outgoingMap = new Map<string, Relationship[]>();
  const incomingMap = new Map<string, Relationship[]>();

  for (const rel of relationships) {
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
      const importedBy = sourcesOf(inRels, 'imports');
      const references = annotatedTargets(outRels, 'references');
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

      pushEventLinks(lines, outRels);

      lines.push('');
    }
  }

  // 4. Symbol Connections
  const virtualIds = new Set([...Object.keys(map.eventChannels), ...Object.keys(map.unresolved)]);
  const symbolKeySet = new Set(Object.keys(map.symbols));
  for (const rel of relationships) {
    if (rel.from.includes(':') && !virtualIds.has(rel.from)) symbolKeySet.add(rel.from);
    if (rel.to.includes(':') && !virtualIds.has(rel.to)) symbolKeySet.add(rel.to);
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
      const calledBy = sourcesOf(inRels, 'calls');
      const symbolReferences = annotatedTargets(outRels, 'references');
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

      pushEventLinks(lines, outRels);

      lines.push('');
    }
  }

  // 4b. Event Channels
  const channelIds = Object.keys(map.eventChannels).sort();
  if (channelIds.length > 0) {
    lines.push('## Event Channels');
    lines.push('');

    for (const channelId of channelIds) {
      const channel = map.eventChannels[channelId];
      lines.push(`### ${channelId}`);
      lines.push('');
      lines.push(`Event: ${channel?.name ?? channelId}`);
      if (channel?.scope) lines.push(`Scope: ${channel.scope}`);

      const inRels = incomingMap.get(channelId) ?? [];
      for (const [type, label] of EVENT_INCOMING) {
        const sources = dedupe(
          inRels
            .filter((r) => r.type === type)
            .map((r) => `${r.from}${annotate(r)}`)
            .sort(),
        );
        if (sources.length === 0) continue;
        lines.push(`${label}:`);
        for (const source of sources) {
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
        .filter((r) => r.type === 'generates')
        .map((r) => r.from)
        .sort();
      const consumedBy = inRels
        .filter((r) => r.type === 'consumes')
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

  // 5b. Unresolved Observations
  const unresolvedIds = Object.keys(map.unresolved).sort();
  if (unresolvedIds.length > 0) {
    lines.push('## Unresolved Observations');
    lines.push('');

    for (const unresolvedId of unresolvedIds) {
      const node = map.unresolved[unresolvedId];
      lines.push(`### ${unresolvedId}`);
      lines.push('');

      if (node) {
        lines.push(`Reason: ${node.reason}`);
        lines.push(`Subject: ${node.subject}`);
        if (node.detail) lines.push(`Detail: ${node.detail}`);
        lines.push(`Attempted: ${node.attempted}`);
        lines.push(
          `Location: ${node.location.filePath}:${node.location.startLine}:${node.location.startColumn}`,
        );
        if (node.candidates && node.candidates.length > 0) {
          lines.push('Candidates:');
          for (const candidate of node.candidates) {
            lines.push(`  - ${candidate}`);
          }
        }
      }

      const observedFrom = dedupe(
        (incomingMap.get(unresolvedId) ?? []).map((r) => `${r.from} (${r.type})`).sort(),
      );
      if (observedFrom.length > 0) {
        lines.push('Observed from:');
        for (const source of observedFrom) {
          lines.push(`  ← ${source}`);
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

const EVENT_OUTGOING: ReadonlyArray<readonly [EventRelationship, string]> = [
  ['emits', 'Emits'],
  ['dispatches', 'Dispatches'],
  ['subscribes', 'Subscribes to'],
  ['unsubscribes', 'Unsubscribes from'],
];

const EVENT_INCOMING: ReadonlyArray<readonly [EventRelationship, string]> = [
  ['emits', 'Emitted by'],
  ['dispatches', 'Dispatched by'],
  ['subscribes', 'Subscribed by'],
  ['unsubscribes', 'Unsubscribed by'],
];

/** Annotate only what changes interpretation: reduced confidence, one-time and abortable listeners. */
function annotate(rel: Relationship): string {
  const notes: string[] = [];
  if (rel.confidence !== 'high') notes.push(`${rel.confidence} confidence`);
  if (rel.metadata?.['once'] === true) notes.push('once');
  if (rel.metadata?.['abortable'] === true) notes.push('abortable');
  return notes.length > 0 ? ` (${notes.join(', ')})` : '';
}

/** Event relationships that start at this node, grouped by mechanism. */
function pushEventLinks(lines: string[], outgoing: readonly Relationship[]): void {
  for (const [type, label] of EVENT_OUTGOING) {
    const targets = dedupe(annotatedTargets(outgoing, type));
    if (targets.length === 0) continue;
    lines.push(`${label}:`);
    for (const target of targets) {
      lines.push(`  → ${target}`);
    }
  }
}

/** Sorted targets of outgoing relationships of one type, annotated where confidence is reduced. */
function annotatedTargets(outgoing: readonly Relationship[], type: Relationship['type']): string[] {
  return outgoing
    .filter((r) => r.type === type)
    .map((r) => `${r.to}${annotate(r)}`)
    .sort();
}

/** Sorted sources of a node's incoming relationships of one type. */
function sourcesOf(incoming: readonly Relationship[], type: Relationship['type']): string[] {
  return incoming
    .filter((r) => r.type === type)
    .map((r) => r.from)
    .sort();
}

function dedupe(items: readonly string[]): string[] {
  return Array.from(new Set(items));
}
