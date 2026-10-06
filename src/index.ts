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
  UnresolvedReferenceNode,
  UnresolvedReason,
  SourceSpan,
  GraphNode,
  CodeRelationship,
  EventRelationship,
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

export { ConnectionGraph, normalizePath, eventChannelId } from './graph.js';
export { serializeConnectionMap, deserializeConnectionMap } from './serialize.js';
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
  type ConfigProblem,
  type LoadedBalk2Config,
} from './config/index.js';

export type {
  EventProtocol,
  EventDirection,
  EventArgKind,
  ReceiverRule,
} from './analyzer/event-protocols.js';
