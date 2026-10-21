import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type { RegistryConfiguredKey, RegistryDeclarationFact } from '../facts/types.js';
import { compileGlob } from './glob.js';
import { ownerOf } from './owner.js';
import { createPathLookup } from './repository-files.js';
import type { RepositoryProgram } from './repository-program.js';
import { ReceiverResolver } from './receiver-identity.js';
import { keyFactOf, resolveRegistryKey } from './registry-keys.js';
import type { RegistryProtocolCatalog, RegistryProtocolOptions } from './registry-protocols.js';
import { qualifyRegistryReceiver } from './registry-receivers.js';
import { symbolTargetOf } from './registry-targets.js';
import { snippetOf, spanOf } from './spans.js';
import { unwrapExpression } from './static-keys.js';

/**
 * Registrations that come from something other than a registry call: a manifest for generated
 * code, files that register themselves by name, decorators, and dictionary literals. Reads only;
 * the engine decides what each one links to.
 *
 * Every source names its registry explicitly, or is a dictionary the code already declares as one.
 * Nothing is registered by a name or a decorator alone.
 */
export interface DeclarationFacts {
  /** Manifest entries, then discovered files, in the order they are applied. */
  readonly configured: readonly RegistryConfiguredKey[];
  /** Decorator registrations in file order, then dictionary-literal registrations in file order. */
  readonly declarations: readonly RegistryDeclarationFact[];
}

export function extractDeclarationFacts(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  catalog: RegistryProtocolCatalog,
  options: RegistryProtocolOptions,
): DeclarationFacts {
  return {
    configured: [
      ...manifestKeys(options.manifest ?? [], graph),
      ...discoveredKeys(options.discover ?? [], repository, graph),
    ],
    declarations: [
      ...decoratedFacts(options.decorators ?? [], repository, graph),
      ...literalFacts(repository, graph, catalog),
    ],
  };
}

/** A key's target is recorded only when it is a node in the graph, so an edge is never guessed. */
function inGraph(graph: ConnectionGraph, id: string): boolean {
  return graph.hasSymbol(id) || graph.hasFile(id);
}

function configuredKey(
  graph: ConnectionGraph,
  registry: string,
  key: string,
  target: string,
): RegistryConfiguredKey {
  return inGraph(graph, target) ? { registry, key, target } : { registry, key };
}

/** `manifest`: explicit registrations, for code that is generated or registered at runtime. */
function manifestKeys(
  entries: NonNullable<RegistryProtocolOptions['manifest']>,
  graph: ConnectionGraph,
): RegistryConfiguredKey[] {
  return entries.map((entry) => configuredKey(graph, entry.registry, entry.key, entry.target));
}

/**
 * `discover`: each file matching a glob registers itself under its name, without the extension,
 * with the file as its target. The registry is the one the rule names.
 */
function discoveredKeys(
  rules: NonNullable<RegistryProtocolOptions['discover']>,
  repository: RepositoryProgram,
  graph: ConnectionGraph,
): RegistryConfiguredKey[] {
  const files = [...repository.sourceFiles.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const found: RegistryConfiguredKey[] = [];
  for (const rule of rules) {
    const matches = compileGlob(rule.glob);
    for (const filePath of files) {
      if (!matches.test(filePath)) continue;
      found.push(configuredKey(graph, rule.registry, stemOf(filePath), filePath));
    }
  }
  return found;
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
function decoratedFacts(
  rules: NonNullable<RegistryProtocolOptions['decorators']>,
  repository: RepositoryProgram,
  graph: ConnectionGraph,
): RegistryDeclarationFact[] {
  if (rules.length === 0) return [];
  const rulesByName = new Map(rules.map((rule) => [rule.name, rule]));
  const checker = repository.checker;
  const found: RegistryDeclarationFact[] = [];

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

          found.push({
            kind: 'registry-declaration',
            filePath,
            span: spanOf(call, filePath),
            source: 'decorator',
            subject: snippetOf(call),
            registry: rule.registry,
            key: keyFactOf(key),
            target,
            targetInGraph: inGraph(graph, target),
            confidence: 'high',
            evidence: 'config',
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}

/**
 * Dictionary literals: `const routes: Record<string, unknown> = { home: Home }` registers each
 * property whose value is a symbol in the repository. The declaration has to be a registry (a
 * dictionary type), so a plain config object such as `const options = { debug: fn }` is not one.
 */
function literalFacts(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  catalog: RegistryProtocolCatalog,
): RegistryDeclarationFact[] {
  const checker = repository.checker;
  const pathOf = createPathLookup(repository);
  const receivers = new ReceiverResolver(repository);
  const found: RegistryDeclarationFact[] = [];

  for (const [filePath, sourceFile] of sortedFiles(repository)) {
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
            found.push({
              kind: 'registry-declaration',
              filePath,
              span: spanOf(property, filePath),
              source: 'literal',
              subject: snippetOf(property),
              registry: identity.scope,
              key: {
                kind: 'static',
                name: entry.key,
                keyType: 'string',
                numericLiteral: false,
                evidence: 'ast',
              },
              target,
              targetInGraph: inGraph(graph, target),
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
  return found;
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
