import type {
  Confidence,
  EventRelationship,
  Evidence,
  RegistryKeyType,
  RegistryRelationship,
  LoadKind,
  SourceSpan,
  StateOperation,
  StateRelationship,
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
  | {
      readonly kind: 'callback';
      readonly span: SourceSpan;
      readonly resolution: CallbackResolution;
    }
  | { readonly kind: 'unknown' };

/**
 * What a callback argument refers to. `inline` is a function written in place, `symbol` a top-level
 * declaration, `external` something no repository file declares (silent), and `unresolved` anything else.
 */
export type CallbackResolution =
  | { readonly kind: 'inline' }
  | { readonly kind: 'symbol'; readonly id: string }
  | { readonly kind: 'external' }
  | { readonly kind: 'unresolved'; readonly subject: string };

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

/**
 * A read, write, delete or method call on shared state, with its resolved root and path. A
 * `dynamicReason` marks a computed key; the engine decides whether it is a wildcard or an
 * observation.
 */
export interface StatePathFact extends FactBase {
  readonly kind: 'state-path';
  readonly owner: string | null;
  readonly relationship: StateRelationship;
  readonly operation: StateOperation;
  /** The state method name, for a `call` operation. */
  readonly method?: string;
  readonly rootKind: StateRootKind;
  /** Resolved root identity, the same form `StatePathNode.root` uses. */
  readonly root: string;
  readonly segments: readonly StatePathSegment[];
  readonly confidence: Confidence;
  readonly evidence: Evidence;
  readonly dynamicReason?: string;
  /** The accessing expression on one line, for observation subjects. */
  readonly subject: string;
}

/** A registry key as read from source: its text and type, a dynamic value, or an argument that cannot be a key. */
export type RegistryKeyFact =
  | {
      readonly kind: 'static';
      readonly name: string;
      readonly keyType: RegistryKeyType;
      /** Written as a numeric literal, so its evidence is the literal's own. */
      readonly numericLiteral: boolean;
      readonly evidence: Evidence;
    }
  | { readonly kind: 'dynamic'; readonly reason: string }
  | { readonly kind: 'not-a-name' };

/** The receiver of a registry call: its identity, and whether it qualifies as a registry. */
export interface RegistryReceiverFact {
  readonly identity:
    | { readonly kind: 'resolved'; readonly scope: string; readonly confidence: Confidence }
    | { readonly kind: 'unknown'; readonly reason: string };
  readonly qualifies: boolean;
  readonly qualificationEvidence: Evidence;
  /** A built-in container whose storage cannot be reached from outside its module or class. */
  readonly internal: boolean;
}

/** A method call, or a dictionary assignment, that a registry protocol may describe. */
export interface RegistryCallFact extends FactBase {
  readonly kind: 'registry-call';
  readonly owner: string;
  readonly subject: string;
  readonly assignment: boolean;
  readonly relationship: RegistryRelationship;
  readonly protocolSource: 'built-in' | 'config';
  /** The protocol's receiver rule is configured, not the built-in `registry-like` check. */
  readonly configuredReceiver: boolean;
  readonly receiver: RegistryReceiverFact;
  readonly key: RegistryKeyFact;
  /** The symbol the value argument names, when it is in the graph. */
  readonly target?: string;
}

/**
 * A registration made by a decorator or a dictionary literal. The target is the symbol the key
 * maps to; for a decorator it is the decorated class or method, which is also where a dynamic key
 * is reported from.
 */
export interface RegistryDeclarationFact extends FactBase {
  readonly kind: 'registry-declaration';
  readonly source: 'decorator' | 'literal';
  readonly subject: string;
  readonly registry: string;
  /** Static, or dynamic when a decorator's key is not known. */
  readonly key: RegistryKeyFact;
  readonly target: string;
  /** The target is a node in the graph, so the key maps to it. */
  readonly targetInGraph: boolean;
  readonly confidence: Confidence;
  readonly evidence: Evidence;
}

/** A constructor parameter whose decorator names a dependency: the enclosing class looks the key up. */
export interface RegistryInjectionFact extends FactBase {
  readonly kind: 'registry-injection';
  readonly owner: string;
  readonly registry: string;
  readonly key: RegistryKeyFact;
  readonly subject: string;
}

/**
 * Registry facts, in the order the registry pass reads them: declarations (decorators, then
 * literals), then parameter injections, then calls. The engine keeps each kind's order.
 */
export type RegistryFact = RegistryDeclarationFact | RegistryInjectionFact | RegistryCallFact;

/**
 * A registration from configuration: a manifest entry, or a file discovered by glob. These have no
 * source span, so they are not facts. `target` is present only when it is in the graph.
 */
export interface RegistryConfiguredKey {
  readonly registry: string;
  readonly key: string;
  readonly target?: string;
}

/** The direction a protocol call takes on an event channel. */
export type EventDirectionFact = 'subscribe' | 'unsubscribe' | 'emit' | 'dispatch';

/** An event name as read from source: static, dynamic with its reason, or an argument that cannot be a name. */
export type EventNameFact =
  | { readonly kind: 'static'; readonly name: string }
  | { readonly kind: 'dynamic'; readonly reason: string }
  | { readonly kind: 'not-a-name' };

/** Listener flags an options argument sets, recorded only when known to be `true`. */
export type EventListenerFlags = Readonly<
  Partial<Record<'once' | 'capture' | 'passive' | 'abortable', true>>
>;

/** The receiver of an event call: its identity, and whether it qualifies as an emitter. */
export interface EventReceiverFact {
  readonly identity:
    | { readonly kind: 'resolved'; readonly scope: string; readonly confidence: Confidence }
    | { readonly kind: 'unknown'; readonly reason: string };
  readonly qualifies: boolean;
  readonly qualificationEvidence: Evidence;
  /** Why the receiver does not qualify, when the front end knows. */
  readonly reason?: string;
}

/**
 * A method call that an event protocol may describe. Claimed calls are included, flagged, because
 * they still count as evidence that a receiver is an emitter.
 */
export interface EventCallFact extends FactBase {
  readonly kind: 'event-call';
  readonly owner: string;
  readonly subject: string;
  readonly direction: EventDirectionFact;
  readonly relationship: EventRelationship;
  readonly protocolSource: 'built-in' | 'config';
  /** The protocol's receiver rule is `event-like`: the receiver's type must look like an emitter. */
  readonly eventLikeReceiver: boolean;
  /** The listener runs at most once. */
  readonly once: boolean;
  /** State claimed the call, so it is not an event. */
  readonly claimed: boolean;
  readonly receiver: EventReceiverFact;
  readonly name: EventNameFact;
  /** The listener's symbol, when a subscribe or unsubscribe names one in the graph. */
  readonly listener?: string;
  /** The listener options, for a subscribe or unsubscribe that passes them. */
  readonly options?: EventListenerFlags;
}

/** A `# balk2:` or `// balk2:` source annotation, before it is applied. */
export interface Directive extends FactBase {
  readonly kind: 'directive';
  readonly owner: string | null;
  readonly text: string;
}

/** Any fact a front end can emit. */
export type Fact =
  | Declaration
  | ModuleEdge
  | ResolvedReference
  | CallSite
  | StatePathFact
  | RegistryCallFact
  | RegistryDeclarationFact
  | RegistryInjectionFact
  | EventCallFact
  | Directive;

/** The kinds of fact, as discriminants. */
export type FactKind = Fact['kind'];

/** Facts from one file, in source order. */
export interface FileFacts {
  readonly filePath: string;
  readonly language: FactLanguage;
  readonly facts: readonly Fact[];
}
