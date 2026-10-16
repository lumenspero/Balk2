import { forwardRelationships, getStateCoupling } from '../graph-queries.js';
import type {
  ConnectionMap,
  EventRelationship,
  Relationship,
  RegistryRelationship,
  StateRelationship,
} from '../types.js';
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
  const registryCount = Object.keys(map.registryKeys).length;
  const metadataCount = Object.keys(map.metadataKeys).length;
  const resourceCount = Object.keys(map.resources).length;
  const internalCount = Object.values(map.unresolved).filter(
    (node) => node.tier === 'internal',
  ).length;
  const unresolvedCount = Object.keys(map.unresolved).length - internalCount;

  lines.push('## Repository Overview');
  lines.push('');
  lines.push(`- **Files**: ${fileCount}`);
  lines.push(`- **Symbols**: ${symbolCount}`);
  lines.push(`- **Data Artifacts**: ${artifactCount}`);
  if (channelCount > 0) lines.push(`- **Event Channels**: ${channelCount}`);
  if (registryCount > 0) lines.push(`- **Registry Keys**: ${registryCount}`);
  if (metadataCount > 0) lines.push(`- **Metadata Keys**: ${metadataCount}`);
  if (resourceCount > 0) lines.push(`- **Resources**: ${resourceCount}`);
  const statePathCount = Object.keys(map.statePaths).length;
  if (statePathCount > 0) lines.push(`- **State Paths**: ${statePathCount}`);
  if (unresolvedCount > 0 || internalCount > 0) {
    const internalNote =
      internalCount > 0 ? ` (${internalCount} internal, in connection-map.json)` : '';
    lines.push(`- **Unresolved Observations**: ${unresolvedCount}${internalNote}`);
    // Actionable observations by reason, so dynamic and ambiguous code is visible at a glance.
    const byReason = new Map<string, number>();
    for (const node of Object.values(map.unresolved)) {
      if (node.tier === 'internal') continue;
      byReason.set(node.reason, (byReason.get(node.reason) ?? 0) + 1);
    }
    for (const [reason, count] of [...byReason].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      lines.push(`  - ${reason}: ${count}`);
    }
  }
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

      const imports = importsOf(outRels);
      const importedBy = importsOf(inRels, 'from');
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

      pushResourceLinks(lines, outRels);
      pushCallbackLinks(lines, outRels, inRels);
      pushMetadataLinks(lines, outRels);
      pushEventLinks(lines, outRels);
      pushRegistryLinks(lines, outRels);

      lines.push('');
    }
  }

  // 4. Symbol Connections
  const virtualIds = new Set([
    ...Object.keys(map.eventChannels),
    ...Object.keys(map.registryKeys),
    ...Object.keys(map.metadataKeys),
    ...Object.keys(map.resources),
    ...Object.keys(map.statePaths),
    ...Object.keys(map.unresolved),
  ]);
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
      // Dynamic loads and loaders are owned by the symbol that performs them, so they show here.
      const symbolImports = importsOf(outRels);

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

      if (symbolImports.length > 0) {
        lines.push('Imports:');
        for (const imp of dedupe(symbolImports)) {
          lines.push(`  → ${imp}`);
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

      pushResourceLinks(lines, outRels);
      pushCallbackLinks(lines, outRels, inRels);
      pushMetadataLinks(lines, outRels);
      pushEventLinks(lines, outRels);
      pushRegistryLinks(lines, outRels);

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

  // 4c. Registries
  const registryIds = Object.keys(map.registryKeys).sort();
  if (registryIds.length > 0) {
    lines.push('## Registries');
    lines.push('');

    for (const keyId of registryIds) {
      const node = map.registryKeys[keyId];
      lines.push(`### ${keyId}`);
      lines.push('');
      if (node) {
        lines.push(`Key: ${node.key}`);
        lines.push(`Registry: ${node.scope}`);
        if (node.keyType === 'number') lines.push('Key type: number');
      }

      const outRels = outgoingMap.get(keyId) ?? [];
      const inRels = incomingMap.get(keyId) ?? [];
      const registeredTo = annotatedTargets(outRels, 'registers');
      if (registeredTo.length > 0) {
        lines.push('Registered to:');
        for (const target of dedupe(registeredTo)) {
          lines.push(`  → ${target}`);
        }
      }

      for (const [type, label] of REGISTRY_INCOMING) {
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

  // 4d. Metadata Keys: Reflect metadata keys configured in protocols.metadata
  const metadataIds = Object.keys(map.metadataKeys).sort();
  if (metadataIds.length > 0) {
    lines.push('## Metadata Keys');
    lines.push('');

    for (const keyId of metadataIds) {
      const node = map.metadataKeys[keyId];
      lines.push(`### ${keyId}`);
      lines.push('');
      if (node) lines.push(`Key: ${node.key}`);

      const inRels = incomingMap.get(keyId) ?? [];
      for (const [type, label] of METADATA_INCOMING) {
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

  // 4e. Resources: templates, stylesheets and schemas that code uses
  const resourceIds = Object.keys(map.resources).sort();
  if (resourceIds.length > 0) {
    lines.push('## Resources');
    lines.push('');

    for (const resourceId of resourceIds) {
      const node = map.resources[resourceId];
      lines.push(`### ${resourceId}`);
      lines.push('');
      if (node) lines.push(`Kind: ${node.resourceKind}`);

      const inRels = incomingMap.get(resourceId) ?? [];
      const users = dedupe(
        inRels
          .filter((r) => r.type === 'usesResource')
          .map((r) => `${r.from}${resourceMechanism(r)}${annotate(r)}`)
          .sort(),
      );
      if (users.length > 0) {
        lines.push('Used by:');
        for (const user of users) {
          lines.push(`  ← ${user}`);
        }
      }

      lines.push('');
    }
  }

  // 4f. Shared State Coupling: data coupling, kept apart from imports and calls
  const coupled = getStateCoupling(map);
  if (coupled.length > 0) {
    lines.push('## Shared State Coupling');
    lines.push('');
    lines.push(
      'State that one owner writes and another reads or writes. This is data coupling, not an import or a call.',
    );
    lines.push('');

    for (const { path } of coupled) {
      lines.push(`### ${path}`);
      lines.push('');
      const node = map.statePaths[path];
      if (node) lines.push(`Root: ${node.root}`);

      const inRels = incomingMap.get(path) ?? [];
      for (const [type, label] of STATE_INCOMING) {
        const sources = dedupe(
          inRels
            .filter((r) => r.type === type)
            .map(stateSource)
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

  // 5b. Unresolved Observations. Internal ones (built-in container bookkeeping) stay in the JSON.
  const unresolvedIds = Object.keys(map.unresolved)
    .filter((id) => map.unresolved[id]?.tier !== 'internal')
    .sort();
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

const REGISTRY_OUTGOING: ReadonlyArray<readonly [RegistryRelationship, string]> = [
  ['resolves', 'Resolves'],
  ['routesTo', 'Routes to'],
];

const REGISTRY_INCOMING: ReadonlyArray<readonly [RegistryRelationship, string]> = [
  ['resolves', 'Looked up by'],
  ['routesTo', 'Routed to by'],
];

const METADATA_INCOMING: ReadonlyArray<readonly [Relationship['type'], string]> = [
  ['definesMetadata', 'Defined on'],
  ['readsMetadata', 'Read by'],
];

/** Registry lookups that start at this node: the keys it resolves or routes to. */
function pushRegistryLinks(lines: string[], outgoing: readonly Relationship[]): void {
  for (const [type, label] of REGISTRY_OUTGOING) {
    const targets = dedupe(annotatedTargets(outgoing, type));
    if (targets.length === 0) continue;
    lines.push(`${label}:`);
    for (const target of targets) {
      lines.push(`  → ${target}`);
    }
  }
}

/** Resources this node uses, with how it uses them. */
function pushResourceLinks(lines: string[], outgoing: readonly Relationship[]): void {
  const uses = dedupe(
    outgoing
      .filter((r) => r.type === 'usesResource')
      .map((r) => `${r.to}${resourceMechanism(r)}${annotate(r)}`)
      .sort(),
  );
  if (uses.length === 0) return;
  lines.push('Uses resource:');
  for (const target of uses) {
    lines.push(`  → ${target}`);
  }
}

/** The mechanism suffix for a resource edge: `(import)` or `(loader)`. */
function resourceMechanism(rel: Relationship): string {
  const mechanism = rel.metadata?.['mechanism'];
  return typeof mechanism === 'string' ? ` (${mechanism})` : '';
}

/** Metadata keys this node defines on a target or reads, shown from the owner's side. */
function pushMetadataLinks(lines: string[], outgoing: readonly Relationship[]): void {
  const defines = dedupe(annotatedTargets(outgoing, 'definesMetadata'));
  if (defines.length > 0) {
    lines.push('Defines metadata:');
    for (const target of defines) {
      lines.push(`  → ${target}`);
    }
  }

  const reads = dedupe(annotatedTargets(outgoing, 'readsMetadata'));
  if (reads.length > 0) {
    lines.push('Reads metadata:');
    for (const target of reads) {
      lines.push(`  → ${target}`);
    }
  }
}

const STATE_INCOMING: ReadonlyArray<readonly [StateRelationship, string]> = [
  ['writesState', 'Written by'],
  ['deletesState', 'Deleted by'],
  ['readsState', 'Read by'],
];

/** A state accessor, with the method when a call made the access. */
function stateSource(rel: Relationship): string {
  const method = rel.metadata?.['method'];
  return `${rel.from}${annotate(rel)}${typeof method === 'string' ? ` via ${method}` : ''}`;
}

/** Annotate only what changes interpretation: reduced confidence, one-time and abortable listeners. */
function annotate(rel: Relationship): string {
  const notes: string[] = [];
  if (rel.confidence !== 'high') notes.push(`${rel.confidence} confidence`);
  if (rel.metadata?.['once'] === true) notes.push('once');
  if (rel.metadata?.['abortable'] === true) notes.push('abortable');
  return notes.length > 0 ? ` (${notes.join(', ')})` : '';
}

/**
 * How an import edge is loaded, as a suffix: `(import-expression)`, `(loader)`, and so on.
 * A static import or `require` carries no `loadKind`, so it gets no suffix and renders as before.
 */
function loadSuffix(rel: Relationship): string {
  const kind = rel.metadata?.['loadKind'];
  return typeof kind === 'string' ? ` (${kind})` : '';
}

/**
 * Sorted `imports` targets from a node's relationships. `end` selects the other side: `'to'` for
 * what this node imports, `'from'` for what imports this node. Each target keeps its load kind.
 */
function importsOf(rels: readonly Relationship[], end: 'to' | 'from' = 'to'): string[] {
  return rels
    .filter((r) => r.type === 'imports')
    .map((r) => `${end === 'to' ? r.to : r.from}${loadSuffix(r)}${annotate(r)}`)
    .sort();
}

/**
 * Callbacks passed by this node (`Passes callback to`) and passed to this node
 * (`Passed as callback by`). An inline callback targets its own enclosing symbol, so it is marked
 * `(inline)` to make the self-link readable.
 */
function pushCallbackLinks(
  lines: string[],
  outgoing: readonly Relationship[],
  incoming: readonly Relationship[],
): void {
  const passes = dedupe(
    outgoing
      .filter((r) => r.type === 'passesCallback')
      .map((r) => `${r.to}${callbackNote(r)}`)
      .sort(),
  );
  if (passes.length > 0) {
    lines.push('Passes callback to:');
    for (const target of passes) {
      lines.push(`  → ${target}`);
    }
  }

  const passedBy = dedupe(
    incoming
      .filter((r) => r.type === 'passesCallback')
      .map((r) => `${r.from}${callbackNote(r)}`)
      .sort(),
  );
  if (passedBy.length > 0) {
    lines.push('Passed as callback by:');
    for (const source of passedBy) {
      lines.push(`  ← ${source}`);
    }
  }
}

/** The annotation for a callback edge: the usual notes, plus `inline` for an inline callback. */
function callbackNote(rel: Relationship): string {
  const base = annotate(rel);
  if (rel.metadata?.['inline'] !== true) return base;
  return base ? base.replace(/\)$/, ', inline)') : ' (inline)';
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
