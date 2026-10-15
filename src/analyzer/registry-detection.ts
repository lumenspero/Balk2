import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type { Evidence, UnresolvedReason } from '../types.js';
import { ownerOf, enclosingOwner } from './owner.js';
import { createPathLookup, type PathLookup } from './repository-files.js';
import type { RepositoryProgram } from './repository-program.js';
import { ReceiverResolver } from './receiver-identity.js';
import { resolveRegistryKey, type RegistryKeyResolution } from './registry-keys.js';
import {
  RegistryProtocolCatalog,
  type RegistryProtocolOptions,
  type ResolvedRegistryProtocol,
} from './registry-protocols.js';
import { qualifyRegistryReceiver } from './registry-receivers.js';
import { snippetOf, spanOf } from './spans.js';
import { unwrapExpression } from './static-keys.js';

/** `registry[key] = value`: a registration by assignment, on a dictionary only. */
const ASSIGNMENT: ResolvedRegistryProtocol = {
  method: '[]=',
  direction: 'register',
  relationship: 'registers',
  keyArg: 0,
  valueArg: 1,
  receiver: 'registry-like',
  source: 'built-in',
};

interface RegistryCall {
  readonly filePath: string;
  /** The call expression, or the assignment expression */
  readonly node: ts.Expression;
  readonly receiver: ts.Expression;
  readonly keyExpression: ts.Expression;
  readonly valueExpression: ts.Expression | undefined;
  readonly protocol: ResolvedRegistryProtocol;
  readonly assignment: boolean;
}

/**
 * Registry pass: map registry calls (`container.set('user', User)`, `container.get('user')`,
 * `router.navigate('/users')`) and dictionary assignments (`handlers[404] = NotFound`) onto
 * registry keys.
 *
 * A registration links the key to the symbol it maps to with `registers`. A lookup links its
 * caller to the key with `resolves` or `routesTo`. A key is scoped by the identity of its registry,
 * so the same name in two registries stays two keys. A dynamic key, or a receiver whose identity
 * cannot be read, becomes an unresolved observation rather than a guessed edge.
 *
 * Runs after the per-file pass, so the symbols a registration maps to already exist in the graph.
 */
export function collectRegistryRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  options: RegistryProtocolOptions = {},
): void {
  const catalog = new RegistryProtocolCatalog(options);
  const receivers = new ReceiverResolver(repository);
  const checker = repository.checker;
  const pathOf = createPathLookup(repository);

  for (const call of collectRegistryCalls(repository, catalog)) {
    const { filePath, node, receiver, protocol } = call;

    // A registration by assignment needs a known value. Otherwise `env['X'] = 'y'` on any
    // dictionary would become a key.
    const target = call.valueExpression
      ? symbolTargetOf(call.valueExpression, checker, graph, pathOf)
      : undefined;
    if (call.assignment && target === undefined) continue;

    const qualification = qualifyRegistryReceiver(protocol.receiver, receiver, catalog, checker);
    if (!qualification.qualifies) continue;

    const key = resolveRegistryKey(call.keyExpression, checker, qualification.container);
    if (key.kind === 'not-a-name') continue;

    const span = spanOf(node, filePath);
    const owner = enclosingOwner(node, filePath);
    const identity = receivers.resolve(receiver);

    const observe = (reason: UnresolvedReason, detail: string): void => {
      const unresolved = graph.addUnresolved({
        reason,
        attempted: protocol.relationship,
        subject: snippetOf(node),
        location: span,
        detail,
      });
      graph.addRelationship(protocol.relationship, owner, unresolved.id, 'low', {
        evidence: 'ts-program',
        spans: [span],
      });
    };

    if (key.kind === 'dynamic') {
      observe('dynamic-registry-key', key.reason);
      continue;
    }

    if (identity.kind === 'unknown') {
      observe('unknown-registry-receiver', identity.reason);
      continue;
    }

    const registryKey = graph.addRegistryKey(key.name, identity.scope, key.keyType);
    const evidence = evidenceOf(protocol, qualification.evidence, key);
    const confidence = identity.confidence === 'high' ? 'high' : 'medium';

    if (protocol.relationship === 'registers') {
      if (target !== undefined) {
        graph.addRelationship('registers', registryKey.id, target, confidence, {
          evidence,
          spans: [span],
        });
      }
      continue;
    }

    graph.addRelationship(protocol.relationship, owner, registryKey.id, confidence, {
      evidence,
      spans: [span],
    });
  }
}

/**
 * Every call whose method has a registry protocol, and every dictionary assignment, in a stable
 * order. Receivers are checked later, because most method names match nothing.
 */
function collectRegistryCalls(
  repository: RepositoryProgram,
  catalog: RegistryProtocolCatalog,
): RegistryCall[] {
  const found: RegistryCall[] = [];
  const files = [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  for (const [filePath, sourceFile] of files) {
    if (sourceFile.isDeclarationFile) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = unwrapExpression(node.expression);
        let method: string | undefined;
        let receiver: ts.Expression | undefined;

        if (ts.isPropertyAccessExpression(callee)) {
          method = callee.name.text;
          receiver = callee.expression;
        } else if (
          ts.isElementAccessExpression(callee) &&
          ts.isStringLiteralLike(callee.argumentExpression)
        ) {
          method = callee.argumentExpression.text;
          receiver = callee.expression;
        }

        const protocol = method !== undefined ? catalog.forMethod(method) : undefined;
        const keyExpression = protocol ? node.arguments[protocol.keyArg] : undefined;
        if (protocol && receiver && keyExpression) {
          found.push({
            filePath,
            node,
            receiver,
            keyExpression,
            valueExpression:
              protocol.valueArg !== undefined ? node.arguments[protocol.valueArg] : undefined,
            protocol,
            assignment: false,
          });
        }
      } else if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isElementAccessExpression(node.left)
      ) {
        found.push({
          filePath,
          node,
          receiver: node.left.expression,
          keyExpression: node.left.argumentExpression,
          valueExpression: node.right,
          protocol: ASSIGNMENT,
          assignment: true,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return found;
}

/**
 * The graph symbol a registered value names (`User`, `this.handler`, a function): the same
 * ownership rule the listener pass uses, so the id matches the symbol node. Classes are valid
 * targets here, unlike listeners. Anything else (a parameter, a literal, a call) is `undefined`.
 */
function symbolTargetOf(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  graph: ConnectionGraph,
  pathOf: PathLookup,
): string | undefined {
  const node = unwrapExpression(expression);
  const nameNode = ts.isIdentifier(node)
    ? node
    : ts.isPropertyAccessExpression(node)
      ? node.name
      : undefined;
  if (!nameNode) return undefined;

  let symbol = checker.getSymbolAtLocation(nameNode);
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }

  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!declaration) return undefined;

  const sourceFile = declaration.getSourceFile();
  const filePath = pathOf(sourceFile);
  if (filePath === undefined || sourceFile.isDeclarationFile) return undefined;

  const id = ownerOf(declaration, filePath);
  return id !== undefined && graph.hasSymbol(id) ? id : undefined;
}

/** `config` when a configured protocol or rule decided it; otherwise what the compiler saw. */
function evidenceOf(
  protocol: ResolvedRegistryProtocol,
  qualification: Evidence,
  key: Extract<RegistryKeyResolution, { kind: 'static' }>,
): Evidence {
  if (protocol.source === 'config') return 'config';
  if (key.via === 'numeric-literal') return key.evidence;
  return qualification;
}
