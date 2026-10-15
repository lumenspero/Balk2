import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type { Confidence, Evidence, RegistryKeyNode, RegistryKeyType } from '../types.js';
import { compileGlob } from './glob.js';
import { ownerOf } from './owner.js';
import { createPathLookup } from './repository-files.js';
import type { RepositoryProgram } from './repository-program.js';
import { ReceiverResolver } from './receiver-identity.js';
import { resolveRegistryKey } from './registry-keys.js';
import {
  type RegistryProtocolCatalog,
  type RegistryProtocolOptions,
} from './registry-protocols.js';
import { qualifyRegistryReceiver } from './registry-receivers.js';
import { symbolTargetOf } from './registry-targets.js';
import { snippetOf, spanOf } from './spans.js';
import { unwrapExpression } from './static-keys.js';

/**
 * Registrations that come from something other than a registry call: a manifest for generated
 * code, files that register themselves by name, decorators, and dictionary literals. Each adds
 * its keys to `declared`, so lookups can agree with them, and links a key to its target when the
 * target is in the graph.
 *
 * Every source names its registry explicitly, or is a dictionary the code already declares as one.
 * Nothing is registered by a name or a decorator alone.
 */
export function declareRegistrations(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  catalog: RegistryProtocolCatalog,
  options: RegistryProtocolOptions,
  declared: Map<string, RegistryKeyNode>,
): void {
  declareManifest(options.manifest ?? [], graph, declared);
  declareDiscovered(options.discover ?? [], repository, graph, declared);
  declareDecorated(options.decorators ?? [], repository, graph, declared);
  declareObjectLiterals(repository, graph, catalog, declared);
}

interface RegistrationSource {
  readonly registry: string;
  readonly key: string;
  readonly keyType?: RegistryKeyType;
  readonly target: string;
  readonly confidence: Confidence;
  readonly evidence: Evidence;
}

/** Add one key, and its registration if its target is a node in the graph. */
function register(
  graph: ConnectionGraph,
  declared: Map<string, RegistryKeyNode>,
  source: RegistrationSource,
): void {
  const node = graph.addRegistryKey(source.key, source.registry, source.keyType ?? 'string');
  declared.set(node.id, node);
  if (graph.hasSymbol(source.target) || graph.hasFile(source.target)) {
    graph.addRelationship('registers', node.id, source.target, source.confidence, {
      evidence: source.evidence,
    });
  }
}

/** `manifest`: explicit registrations, for code that is generated or registered at runtime. */
function declareManifest(
  entries: NonNullable<RegistryProtocolOptions['manifest']>,
  graph: ConnectionGraph,
  declared: Map<string, RegistryKeyNode>,
): void {
  for (const entry of entries) {
    register(graph, declared, {
      registry: entry.registry,
      key: entry.key,
      target: entry.target,
      confidence: 'high',
      evidence: 'config',
    });
  }
}

/**
 * `discover`: each file matching a glob registers itself under its name, without the extension,
 * with the file as its target. The registry is the one the rule names.
 */
function declareDiscovered(
  rules: NonNullable<RegistryProtocolOptions['discover']>,
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  declared: Map<string, RegistryKeyNode>,
): void {
  const files = [...repository.sourceFiles.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const rule of rules) {
    const matches = compileGlob(rule.glob);
    for (const filePath of files) {
      if (!matches.test(filePath)) continue;
      register(graph, declared, {
        registry: rule.registry,
        key: stemOf(filePath),
        target: filePath,
        confidence: 'high',
        evidence: 'config',
      });
    }
  }
}

function stemOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * `decorators`: `@register('user')` on a class or method registers the decorated symbol under the
 * key, in the registry the rule names. Only calls to a named identifier count, so an unrelated
 * decorator with the same name elsewhere does not, once it is configured.
 */
function declareDecorated(
  rules: NonNullable<RegistryProtocolOptions['decorators']>,
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  declared: Map<string, RegistryKeyNode>,
): void {
  if (rules.length === 0) return;
  const rulesByName = new Map(rules.map((rule) => [rule.name, rule]));
  const checker = repository.checker;

  for (const [filePath, sourceFile] of sortedFiles(repository)) {
    if (sourceFile.isDeclarationFile) continue;

    const visit = (node: ts.Node): void => {
      if (
        (ts.isClassDeclaration(node) || ts.isMethodDeclaration(node)) &&
        ts.canHaveDecorators(node)
      ) {
        const target = ownerOf(node, filePath);
        for (const decorator of ts.getDecorators(node) ?? []) {
          const call = decorator.expression;
          if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue;
          const rule = rulesByName.get(call.expression.text);
          const keyArgument = call.arguments[rule?.keyArg ?? 0];
          if (!rule || !keyArgument || target === undefined) continue;

          const key = resolveRegistryKey(keyArgument, checker, 'typed');
          if (key.kind === 'not-a-name') continue;
          if (key.kind === 'dynamic') {
            const span = spanOf(call, filePath);
            const unresolved = graph.addUnresolved({
              reason: 'dynamic-registry-key',
              attempted: 'registers',
              subject: snippetOf(call),
              location: span,
              detail: key.reason,
            });
            graph.addRelationship('registers', target, unresolved.id, 'low', {
              evidence: 'ts-program',
              spans: [span],
            });
            continue;
          }

          register(graph, declared, {
            registry: rule.registry,
            key: key.name,
            keyType: key.keyType,
            target,
            confidence: 'high',
            evidence: 'config',
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

/**
 * Dictionary literals: `const routes: Record<string, unknown> = { home: Home }` registers each
 * property whose value is a symbol in the repository. The declaration has to be a registry (a
 * dictionary type), so a plain config object such as `const options = { debug: fn }` is not one.
 */
function declareObjectLiterals(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  catalog: RegistryProtocolCatalog,
  declared: Map<string, RegistryKeyNode>,
): void {
  const checker = repository.checker;
  const pathOf = createPathLookup(repository);
  const receivers = new ReceiverResolver(repository);

  for (const [, sourceFile] of sortedFiles(repository)) {
    if (sourceFile.isDeclarationFile) continue;

    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isObjectLiteralExpression(unwrapExpression(node.initializer))
      ) {
        const literal = unwrapExpression(node.initializer) as ts.ObjectLiteralExpression;
        const qualification = qualifyRegistryReceiver('registry-like', node.name, catalog, checker);
        const identity = receivers.resolve(node.name);
        if (
          qualification.qualifies &&
          qualification.container === 'object' &&
          identity.kind === 'resolved'
        ) {
          for (const property of literal.properties) {
            const entry = propertyEntry(property);
            if (!entry) continue;
            const target = symbolTargetOf(entry.value, checker, graph, pathOf);
            if (target === undefined) continue;
            register(graph, declared, {
              registry: identity.scope,
              key: entry.key,
              target,
              confidence: identity.confidence,
              evidence: 'ts-program',
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

/**
 * A property's key and value. Computed keys are not static, so they are skipped; a numeric key is
 * stored as its string form, as a dictionary stores it.
 */
function propertyEntry(
  property: ts.ObjectLiteralElementLike,
): { readonly key: string; readonly value: ts.Expression } | undefined {
  if (ts.isShorthandPropertyAssignment(property)) {
    return { key: property.name.text, value: property.name };
  }
  if (!ts.isPropertyAssignment(property)) return undefined;

  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return { key: name.text, value: property.initializer };
  }
  if (ts.isNumericLiteral(name)) {
    return { key: String(Number(name.text)), value: property.initializer };
  }
  return undefined;
}

function sortedFiles(repository: RepositoryProgram): [string, ts.SourceFile][] {
  return [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
