import * as ts from 'typescript';
import type { ConfigProblem } from '../config/config-problem.js';
import type { StateConfig } from '../config/state-config.js';
import type { Evidence, StatePathSegment, StateRootKind } from '../types.js';
import type { GlobalSymbol, GlobalSymbolIndex } from './global-symbols.js';
import type { RepositoryProgram } from './repository-program.js';
import { isConst, resolveStaticKey, unwrapExpression } from './static-keys.js';

/** The global object's state root; every name for the global object shares it. */
export const GLOBAL_STATE_ROOT = 'global';

/**
 * An expression resolved to shared state: a root plus the property path below it. A `null`
 * segment is a computed property whose name is not statically known; whether that becomes a
 * wildcard or an unresolved observation is decided by the caller.
 */
export interface StateReference {
  /** `global`, `config:<name>`, or `<module>:<export>` */
  readonly root: string;
  readonly rootKind: StateRootKind;
  readonly segments: readonly StatePathSegment[];
  /** `high` when reached directly; `medium` through an alias of a path below a root */
  readonly confidence: 'high' | 'medium';
  readonly evidence: Evidence;
  /** Why the first `null` segment is not static, when there is one */
  readonly dynamicReason?: string;
}

/** A property key: its name, or `null` with the reason it is not statically known. */
export type KeySegment =
  { readonly name: string } | { readonly name: null; readonly reason: string };

const MAX_DEPTH = 6;

/** What a sub-expression turned out to be while walking a property chain. */
type Located =
  | { readonly kind: 'global-object'; readonly confidence: 'high' | 'medium' }
  | ({ readonly kind: 'state' } & StateReference);

/** Which top-level global names are state. */
type GlobalPolicy =
  | { readonly kind: 'none' }
  | { readonly kind: 'listed'; readonly names: ReadonlySet<string> }
  | { readonly kind: 'assigned'; readonly names: ReadonlySet<string> };

/**
 * Decides whether an expression is shared state, and which root and path it names.
 *
 * Three kinds of root are recognized, all from `.balk2.json` `state` plus the global index:
 * - the global object under any of its names, limited to the top-level names `state.globals`
 *   selects (by default, the ones the repository assigns or declares as script variables);
 * - configured roots (`state.roots`), where the name is not bound by repository code;
 * - configured singletons (`state.singletons`), matched by symbol identity, so a renamed import,
 *   a namespace import or a default import all reach the same root.
 *
 * `const` aliases and object destructuring of a resolved expression are followed. Parameters,
 * `let` and `var` bindings are not, since their value is not statically fixed.
 */
export class StateRootResolver {
  /** Configured singletons that could not be matched to an export. */
  readonly problems: readonly ConfigProblem[];

  private readonly checker: ts.TypeChecker;
  private readonly repositoryFiles: ReadonlySet<ts.SourceFile>;
  private readonly configuredRoots: ReadonlySet<string>;
  private readonly policy: GlobalPolicy;
  private readonly singletons: ReadonlyMap<ts.Symbol, string>;

  constructor(
    repository: RepositoryProgram,
    private readonly globals: GlobalSymbolIndex,
    config: StateConfig = {},
  ) {
    this.checker = repository.checker;
    this.repositoryFiles = new Set(repository.sourceFiles.values());
    this.configuredRoots = new Set(config.roots ?? []);
    this.policy = globalPolicy(config.globals, globals);

    const problems: ConfigProblem[] = [];
    this.singletons = this.matchSingletons(repository, config, problems);
    this.problems = problems;
  }

  /** The state an expression reads or writes, or `undefined` when it is not shared state. */
  resolve(expression: ts.Expression): StateReference | undefined {
    const located = this.locate(expression, 0, new Set());
    if (located?.kind !== 'state') return undefined;
    return {
      root: located.root,
      rootKind: located.rootKind,
      segments: located.segments,
      confidence: located.confidence,
      evidence: located.evidence,
      ...(located.dynamicReason !== undefined ? { dynamicReason: located.dynamicReason } : {}),
    };
  }

  private locate(
    expression: ts.Expression,
    depth: number,
    seen: Set<ts.Node>,
  ): Located | undefined {
    if (depth > MAX_DEPTH) return undefined;
    const node = unwrapExpression(expression);

    if (ts.isIdentifier(node)) return this.locateIdentifier(node, depth, seen);
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      return this.locateMember(node, depth, seen);
    }
    return undefined;
  }

  private locateIdentifier(
    node: ts.Identifier,
    depth: number,
    seen: Set<ts.Node>,
  ): Located | undefined {
    const symbol = this.checker.getSymbolAtLocation(node);

    const singleton = symbol ? this.singletonOf(symbol) : undefined;
    if (singleton !== undefined) return state(singleton, 'singleton', [], 'high', 'config');

    if (this.globals.roots.isGlobalRoot(node)) return { kind: 'global-object', confidence: 'high' };

    const bound = symbol !== undefined && this.hasRepositoryBinding(symbol);

    if (this.configuredRoots.has(node.text) && !bound) {
      return state(`config:${node.text}`, 'configured', [], 'high', 'config');
    }

    if (this.isGlobalVariable(node, symbol, bound)) {
      return state(GLOBAL_STATE_ROOT, 'global', [node.text], 'high', 'ts-program');
    }

    return symbol ? this.followAlias(symbol, depth, seen) : undefined;
  }

  private locateMember(
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    depth: number,
    seen: Set<ts.Node>,
  ): Located | undefined {
    // `ns.store` where `ns` is a namespace import: the property itself is the singleton.
    const nameNode = ts.isPropertyAccessExpression(node) ? node.name : undefined;
    const memberSymbol = nameNode ? this.checker.getSymbolAtLocation(nameNode) : undefined;
    const singleton = memberSymbol ? this.singletonOf(memberSymbol) : undefined;
    if (singleton !== undefined) return state(singleton, 'singleton', [], 'high', 'config');

    const base = this.locate(node.expression, depth + 1, seen);
    if (!base) return undefined;

    const segment = this.segmentOf(node);
    if (base.kind === 'global-object') {
      // Which global is meant must be known to apply `state.globals`.
      if (segment.name === null || !this.allowsGlobal(segment.name)) return undefined;
      return state(GLOBAL_STATE_ROOT, 'global', [segment.name], base.confidence, 'ts-program');
    }

    return {
      ...base,
      segments: [...base.segments, segment.name],
      ...(segment.name === null && base.dynamicReason === undefined
        ? { dynamicReason: segment.reason }
        : {}),
    };
  }

  /** Follow `const x = <state>` and `const { a: { b } } = <state>` to the state they name. */
  private followAlias(symbol: ts.Symbol, depth: number, seen: Set<ts.Node>): Located | undefined {
    const target =
      symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
    const declaration = target.valueDeclaration ?? target.declarations?.[0];
    if (!declaration || seen.has(declaration) || !this.isRepositoryNode(declaration)) {
      return undefined;
    }
    seen.add(declaration);

    if (ts.isVariableDeclaration(declaration)) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return undefined;
      if (!isConst(declaration)) return undefined;
      return lowered(this.locate(declaration.initializer, depth + 1, seen));
    }

    if (ts.isBindingElement(declaration)) {
      const destructured = destructuringOf(declaration);
      if (!destructured) return undefined;
      const base = this.locate(destructured.initializer, depth + 1, seen);
      if (!base) return undefined;

      if (base.kind === 'global-object') {
        const [first, ...rest] = destructured.keys;
        if (first === undefined || !this.allowsGlobal(first)) return undefined;
        return state(GLOBAL_STATE_ROOT, 'global', [first, ...rest], 'medium', 'ts-program');
      }
      return lowered({ ...base, segments: [...base.segments, ...destructured.keys] });
    }

    return undefined;
  }

  /** A property name, or `null` with the reason it is not statically known. */
  private segmentOf(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): KeySegment {
    if (ts.isPropertyAccessExpression(node)) return { name: node.name.text };
    return this.keySegment(node.argumentExpression);
  }

  /** A key read from an expression used as a property name or a state method's key argument. */
  keySegment(argument: ts.Expression): KeySegment {
    const key = unwrapExpression(argument);
    if (ts.isNumericLiteral(key)) return { name: String(Number(key.text)) };

    const resolved = resolveStaticKey(key, this.checker);
    if (resolved.kind === 'static') return { name: resolved.name };
    return {
      name: null,
      reason: resolved.kind === 'dynamic' ? resolved.reason : 'property key is not a string',
    };
  }

  /**
   * A bare identifier naming a global variable: a script-scope or ambient `var`/`let`/`const`,
   * or a free name that `state.globals` selects (assigned through the global object somewhere,
   * or listed).
   */
  private isGlobalVariable(
    node: ts.Identifier,
    symbol: ts.Symbol | undefined,
    bound: boolean,
  ): boolean {
    if (!this.allowsGlobal(node.text)) return false;

    if (symbol) {
      const lookup = this.globals.lookupTypeScriptSymbol(symbol);
      const candidates =
        lookup.kind === 'ambiguous'
          ? lookup.candidates
          : lookup.kind === 'none'
            ? []
            : [lookup.symbol];
      // Several script files may declare the same global; it is still one runtime slot.
      if (candidates.some(isVariableGlobal)) return true;
    }

    return !bound;
  }

  private allowsGlobal(name: string): boolean {
    return this.policy.kind !== 'none' && this.policy.names.has(name);
  }

  /** True when a repository declaration (not an ambient one) binds this symbol. */
  private hasRepositoryBinding(symbol: ts.Symbol): boolean {
    return (symbol.declarations ?? []).some(
      (declaration) =>
        BINDING_DECLARATIONS.some((isBinding) => isBinding(declaration)) &&
        this.isRepositoryNode(declaration) &&
        !isAmbient(declaration),
    );
  }

  private isRepositoryNode(node: ts.Node): boolean {
    const sourceFile = node.getSourceFile();
    return this.repositoryFiles.has(sourceFile) && !sourceFile.isDeclarationFile;
  }

  private singletonOf(symbol: ts.Symbol): string | undefined {
    for (const candidate of this.equivalents(symbol)) {
      const root = this.singletons.get(candidate);
      if (root !== undefined) return root;
    }
    return undefined;
  }

  /** A symbol, what it aliases, and the export each one stands for. */
  private equivalents(symbol: ts.Symbol): ts.Symbol[] {
    const found = new Set<ts.Symbol>([symbol]);
    if (symbol.flags & ts.SymbolFlags.Alias) found.add(this.checker.getAliasedSymbol(symbol));
    for (const each of [...found]) found.add(this.checker.getExportSymbolOfSymbol(each));
    return [...found];
  }

  private matchSingletons(
    repository: RepositoryProgram,
    config: StateConfig,
    problems: ConfigProblem[],
  ): Map<ts.Symbol, string> {
    const matched = new Map<ts.Symbol, string>();

    (config.singletons ?? []).forEach((singleton, index) => {
      const at = `state.singletons[${index}]`;
      const sourceFile = repository.sourceFiles.get(singleton.module);
      if (!sourceFile) {
        problems.push({
          path: `${at}.module`,
          message: `"${singleton.module}" is not an analyzed file; entry ignored`,
        });
        return;
      }

      const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile);
      const exported = moduleSymbol
        ? this.checker
            .getExportsOfModule(moduleSymbol)
            .find((symbol) => symbol.escapedName === singleton.export)
        : undefined;
      if (!exported) {
        problems.push({
          path: `${at}.export`,
          message: `"${singleton.module}" has no export "${singleton.export}"; entry ignored`,
        });
        return;
      }

      const root = `${singleton.module}:${singleton.export}`;
      for (const symbol of this.equivalents(exported)) {
        if (!matched.has(symbol)) matched.set(symbol, root);
      }
    });

    return matched;
  }
}

const BINDING_DECLARATIONS: ReadonlyArray<(node: ts.Node) => boolean> = [
  ts.isVariableDeclaration,
  ts.isParameter,
  ts.isBindingElement,
  ts.isFunctionDeclaration,
  ts.isFunctionExpression,
  ts.isClassDeclaration,
  ts.isClassExpression,
  ts.isEnumDeclaration,
  ts.isModuleDeclaration,
  ts.isImportClause,
  ts.isImportSpecifier,
  ts.isNamespaceImport,
  ts.isImportEqualsDeclaration,
];

/** True inside a `declare` context (`declare const x`, `declare global { ... }`), which binds no value. */
function isAmbient(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    const modifiers = ts.canHaveModifiers(current) ? ts.getModifiers(current) : undefined;
    if (modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  }
  return false;
}

/**
 * Top-level global names that are state. `false` selects none; a list selects exactly those;
 * `true` (the default) selects names the repository establishes as data: a script or ambient
 * variable, or a property assigned through the global object. A global function or class is not
 * state, but `window.App.init = fn` still makes the namespace `App` state.
 */
function globalPolicy(setting: StateConfig['globals'], globals: GlobalSymbolIndex): GlobalPolicy {
  if (setting === false) return { kind: 'none' };
  if (Array.isArray(setting)) return { kind: 'listed', names: new Set(setting) };

  const names = new Set<string>();
  for (const symbol of globals.all()) {
    const [first] = symbol.name.split('.');
    if (first === undefined) continue;
    if (symbol.name.includes('.') || isVariableGlobal(symbol)) names.add(first);
  }
  return { kind: 'assigned', names };
}

function isVariableGlobal(symbol: GlobalSymbol): boolean {
  if (symbol.origin === 'assignment') {
    return symbol.symbolType === 'variable' || symbol.symbolType === 'constant';
  }
  return ts.isVariableDeclaration(symbol.declaration);
}

/** The keys a destructured binding reads, outermost first, and the expression it reads them from. */
export function destructuringOf(
  element: ts.BindingElement,
): { readonly keys: string[]; readonly initializer: ts.Expression } | undefined {
  const keys: string[] = [];
  let current: ts.BindingElement = element;

  for (;;) {
    if (current.dotDotDotToken || !ts.isObjectBindingPattern(current.parent)) return undefined;
    const key = current.propertyName ?? current.name;
    if (ts.isIdentifier(key) || ts.isStringLiteral(key)) {
      keys.unshift(key.text);
    } else if (ts.isNumericLiteral(key)) {
      keys.unshift(String(Number(key.text)));
    } else {
      return undefined;
    }

    const holder = current.parent.parent;
    if (ts.isBindingElement(holder)) {
      current = holder;
      continue;
    }
    if (ts.isVariableDeclaration(holder) && holder.initializer && isConst(holder)) {
      return { keys, initializer: holder.initializer };
    }
    return undefined;
  }
}

/** An alias of a path below a root is a copy of a reference, so it is reported at medium. */
function lowered(located: Located | undefined): Located | undefined {
  if (located?.kind !== 'state' || located.segments.length === 0) return located;
  return { ...located, confidence: 'medium' };
}

function state(
  root: string,
  rootKind: StateRootKind,
  segments: readonly StatePathSegment[],
  confidence: 'high' | 'medium',
  evidence: Evidence,
): Located {
  return { kind: 'state', root, rootKind, segments, confidence, evidence };
}
