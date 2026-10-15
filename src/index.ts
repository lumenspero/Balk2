/**
 * Balk2 — Repository Connection Map
 *
 * Generate compact, deterministic connection maps designed
 * for AI-assisted interconnected code changes.
 */

export type {
  NodeKind,
  FileNode,
  SymbolNode,
  SymbolType,
  ArtifactNode,
  ArtifactFormat,
  EventChannelNode,
  RegistryKeyNode,
  UnresolvedReferenceNode,
  UnresolvedReason,
  SourceSpan,
  GraphNode,
  CodeRelationship,
  EventRelationship,
  RegistryRelationship,
  StatePathNode,
  StateRelationship,
  StateRootKind,
  DataRelationship,
  RelationshipType,
  Confidence,
  Evidence,
  RelationshipMetadata,
  RelationshipDetail,
  Relationship,
  RepositoryMetadata,
  ConnectionMap,
  ConnectionMapV1,
} from './types.js';

export { ConnectionGraph, normalizePath, eventChannelId, registryKeyId } from './graph.js';
export { serializeConnectionMap, deserializeConnectionMap } from './serialize.js';
export {
  forwardRelationships,
  getOutgoing,
  getIncoming,
  getEventReactions,
  getEventTriggers,
  getRegistryResolutions,
  getRegistrationTargets,
  getRegistryLookups,
  getStateReaders,
  getStateWriters,
  getStateCoupling,
  type EventReaction,
  type EventTrigger,
  type RegistryResolution,
  type StateCoupling,
} from './graph-queries.js';
export type { Analyzer, AnalyzerOptions } from './analyzer/index.js';
export { JsTsAnalyzer, PythonAnalyzer, resolveImportPath } from './analyzer/index.js';

export {
  SUPPORTED_DATA_EXTENSIONS,
  detectArtifactFormat,
  isDataArtifact,
  registerDataArtifacts,
  inferDataRelationshipType,
  addDataRelationship,
  type DataReference,
} from './data/index.js';

export {
  renderMarkdown,
  findConnectionPaths,
  type MarkdownOptions,
  type PathFinderOptions,
  type FormattedPath,
} from './renderer/index.js';

export {
  generateConnectionMap,
  installGitHook,
  uninstallGitHook,
  checkConnectionMap,
  getGitCommitHash,
  isGitRepository,
  type GenerateOptions,
  type GenerateResult,
  type HookResult,
  type CheckOptions,
  type CheckResult,
} from './cli/index.js';

export {
  loadBalk2Config,
  loadBalk2ConfigDetailed,
  applyExplicitLineage,
  filterFilesWithConfig,
  matchPattern,
  type Balk2Config,
  type DataConfig,
  type DataLineageEntry,
  type GlobalsConfig,
  type ProtocolsConfig,
  type EventProtocolsConfig,
  type RegistryProtocolsConfig,
  type StateConfig,
  type StateSingleton,
  type DynamicPathMode,
  type ConfigProblem,
  type LoadedBalk2Config,
} from './config/index.js';

export type {
  EventProtocol,
  EventDirection,
  EventArgKind,
  ReceiverRule,
} from './analyzer/event-protocols.js';

export type {
  RegistryProtocol,
  RegistryDirection,
  RegistryRule,
} from './analyzer/registry-protocols.js';

export type { StateProtocol, StateAccess } from './analyzer/state-protocols.js';
