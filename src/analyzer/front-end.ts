import type { ConnectionGraph } from '../graph.js';
import type { RepositoryPackages } from '../packages/repository-packages.js';
import type { Balk2Config } from '../config/balk2-config.js';
import type { ConfigProblem } from '../config/config-problem.js';
import type { Annotation, AnnotationProblem } from './annotations.js';
import type { SyntaxErrorNote } from './repository-program.js';
import type { FrontEndBindings } from './bindings/types.js';

/** Languages a front end can analyze. */
export type FrontEndLanguage = 'javascript' | 'typescript' | 'python' | 'rust';

export interface FrontEndInput {
  /** Absolute repository root. */
  readonly rootDir: string;
  /** Repository-relative files that passed the scan and the configured include/exclude filters. */
  readonly files: readonly string[];
  /** Parsed `.balk2.json`, when the repository has one. */
  readonly config?: Balk2Config;
  /** Package facts from step 2 of the build. The Python front end finishes its entry points. */
  readonly packages?: RepositoryPackages;
}

/** `# balk2:` or `// balk2:` directives read from one front end's files. */
export interface FrontEndSourceAnnotations {
  readonly annotations: readonly Annotation[];
  readonly problems: readonly AnnotationProblem[];
}

export interface FrontEndResult {
  /** Configured entries this front end could not use. */
  readonly problems: readonly ConfigProblem[];
  /** Syntax errors recovered from in this front end's files. */
  readonly syntaxErrors: readonly SyntaxErrorNote[];
  /** Source-comment directives from this front end's files. Undefined when it had no files. */
  readonly sourceAnnotations?: FrontEndSourceAnnotations;
  /** Manifest problems found while finishing package facts, reported as `manifest` diagnostics. */
  readonly manifestProblems?: readonly { readonly path: string; readonly message: string }[];
  /** Bindings this front end produces and consumes (V3 Phase 14). Undefined until a front end publishes one. */
  readonly bindings?: FrontEndBindings;
}

/**
 * One language's syntax front end. A front end extracts facts from its own files and writes
 * graph entries for them. Facts and the binding index are added to this result in Phases 2 and 14.
 */
export interface LanguageFrontEnd {
  readonly name: string;
  readonly languages: readonly FrontEndLanguage[];
  canHandle(filePath: string): boolean;
  analyze(input: FrontEndInput, graph: ConnectionGraph): FrontEndResult;
}
