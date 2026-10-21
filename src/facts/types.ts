import type {
  Confidence,
  LoadKind,
  SourceSpan,
  StatePathSegment,
  StateRootKind,
  SymbolType,
  UnresolvedReason,
} from '../types.js';

/**
 * Language-neutral facts extracted by a front end. Facts describe what the code says, with its
 * resolution already applied. Mechanism engines turn facts into graph edges, so nothing in this
 * file refers to a language's syntax tree (Phase 2.1).
 *
 * An `owner` is the id of the symbol that contains the fact (`"<file>:<name>"`), or `null` for
 * module-level code. Owner rules are shared by every front end (Phase 2.6).
 */

/** The source languages a fact can come from. */
export type FactLanguage = 'javascript' | 'typescript' | 'python' | 'rust';

/** Fields every fact carries. */
interface FactBase {
  /** Repository-relative file the fact was read from. */
  readonly filePath: string;
  readonly span: SourceSpan;
}

/** A target that a fact resolved to, or could not resolve. */
export type FactTarget =
  | { readonly kind: 'symbol'; readonly id: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'external'; readonly name: string }
  | { readonly kind: 'unresolved'; readonly reason: UnresolvedReason; readonly subject: string };

/** Who may use a declaration from outside its file. */
export type Visibility = 'public' | 'module' | 'private';

/** A named definition in a file: a function, class, type, constant, or similar. */
export interface Declaration extends FactBase {
  readonly kind: 'declaration';
  readonly id: string;
  readonly name: string;
  readonly symbolType: SymbolType;
  readonly owner: string | null;
  readonly visibility: Visibility;
  readonly exported: boolean;
  /** Conditional-compilation or conditional-import guard as text, never evaluated. */
  readonly condition?: string;
}

/** How a file brings in, or hands on, another module. */
export type ModuleEdgeForm = 'import' | 're-export' | 'declare-module' | 'include' | 'load';

/** A module-level link from one file to a module, which the module system resolved (or did not). */
export interface ModuleEdge extends FactBase {
  readonly kind: 'module-edge';
  readonly owner: string | null;
  readonly form: ModuleEdgeForm;
  /** How a dynamic load happens (`import()`, worker, URL, loader). Set for `load` edges only. */
  readonly loadKind?: LoadKind;
  /** The specifier as written in the source. */
  readonly specifier: string;
  readonly target: FactTarget;
  /** Names bound or re-exported. Empty for a whole-module import. */
  readonly names: readonly string[];
  readonly typeOnly: boolean;
  readonly condition?: string;
}

/** The role a reference plays at its span. */
export type ReferenceRole = 'call' | 'construct' | 'type' | 'decorator' | 'value';

/** A use of a name that resolves to a target. */
export interface ResolvedReference extends FactBase {
  readonly kind: 'reference';
  readonly owner: string | null;
  readonly target: FactTarget;
  readonly role: ReferenceRole;
  readonly confidence: Confidence;
}

/** What a method call's receiver is, and what type it has. */
export interface Receiver {
  /** The receiver's identity: a symbol, a state root, or unknown. */
  readonly identity:
    | { readonly kind: 'symbol'; readonly id: string }
    | { readonly kind: 'state-root'; readonly root: string }
    | { readonly kind: 'unknown' };
  /** The receiver's type: a symbol, an external type name, or unknown. */
  readonly type:
    | { readonly kind: 'symbol'; readonly id: string }
    | { readonly kind: 'external'; readonly name: string }
    | { readonly kind: 'unknown' };
  /** The grade of evidence for `type`, when it is known. */
  readonly typeConfidence?: Confidence;
}

/** Where a relative path is anchored: a file's directory, its package, or the working directory. */
export type PathAnchor = 'file-dir' | 'package-dir' | 'cwd';

/** A statically known argument value, or a reference to a symbol passed as one. */
export type ArgValue =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'path'; readonly anchor: PathAnchor; readonly path: string }
  | { readonly kind: 'symbol'; readonly id: string }
  | { readonly kind: 'dynamic'; readonly reason: string }
  | { readonly kind: 'not-a-name' }
  | { readonly kind: 'unknown' };

/** A call with its receiver and arguments. */
export interface CallSite extends FactBase {
  readonly kind: 'call';
  readonly owner: string | null;
  /** The resolved callee, when the front end resolved it. */
  readonly callee?: FactTarget;
  /** The callee name as written: the identifier, or the method name of a property access. */
  readonly name?: string;
  /** The call's source text, for observation subjects. */
  readonly text?: string;
  readonly receiver?: Receiver;
  /** The method name as written, for method calls only. */
  readonly methodName?: string;
  readonly positional: readonly ArgValue[];
  readonly keyword: Readonly<Record<string, ArgValue>>;
}

/** The operation performed on a state path. */
export type StatePathOperation = 'assignment' | 'read' | 'delete';

/** A read, write or delete of a shared state location. */
export interface StatePathFact extends FactBase {
  readonly kind: 'state-path';
  readonly owner: string | null;
  readonly operation: StatePathOperation;
  readonly rootKind: StateRootKind;
  /** Resolved root identity, the same form `StatePathNode.root` uses. */
  readonly root: string;
  readonly segments: readonly StatePathSegment[];
}

/** A `# balk2:` or `// balk2:` source annotation, before it is applied. */
export interface Directive extends FactBase {
  readonly kind: 'directive';
  readonly owner: string | null;
  readonly text: string;
}

/** Any fact a front end can emit. */
export type Fact =
  Declaration | ModuleEdge | ResolvedReference | CallSite | StatePathFact | Directive;

/** The kinds of fact, as discriminants. */
export type FactKind = Fact['kind'];

/** Facts from one file, in source order. */
export interface FileFacts {
  readonly filePath: string;
  readonly language: FactLanguage;
  readonly facts: readonly Fact[];
}
