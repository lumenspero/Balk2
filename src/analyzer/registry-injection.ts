import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import type { RegistryParameterDecoratorRule } from './registry-protocols.js';
import { ownerOf } from './owner.js';
import type { RepositoryProgram } from './repository-program.js';
import { resolveRegistryKey } from './registry-keys.js';
import { spanOf } from './spans.js';

/**
 * Constructor parameter injection: `constructor(@Inject(UserRepo) repo: UserRepo)`.
 *
 * The enclosing class depends on the key, so it gets a `resolves` edge to the registry key. The
 * owner is the class, since a parameter has no symbol of its own. The key is read from the
 * decorator's argument with the same rules as a lookup, so a class token agrees with its
 * registration. Only constructor parameters are read; method and property injection are not.
 *
 * An unreadable key is reported as an observation, like any other lookup.
 */
export function collectParameterInjections(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  rules: readonly RegistryParameterDecoratorRule[],
): void {
  if (rules.length === 0) return;
  const rulesByName = new Map(rules.map((rule) => [rule.name, rule]));
  const checker = repository.checker;

  for (const [filePath, sourceFile] of [...repository.sourceFiles].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    if (sourceFile.isDeclarationFile) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isConstructorDeclaration(node) && node.parent && ts.isClassDeclaration(node.parent)) {
        const owner = ownerOf(node.parent, filePath);
        if (owner !== undefined) {
          for (const parameter of node.parameters) {
            for (const decorator of ts.getDecorators(parameter) ?? []) {
              const call = decorator.expression;
              if (!ts.isCallExpression(call) || !ts.isIdentifier(call.expression)) continue;
              const rule = rulesByName.get(call.expression.text);
              if (!rule) continue;
              const keyArgument = call.arguments[rule.keyArg ?? 0];
              if (!keyArgument) continue;

              const span = spanOf(call, filePath);
              const key = resolveRegistryKey(keyArgument, checker, 'typed');
              if (key.kind === 'not-a-name') continue;

              if (key.kind === 'dynamic') {
                const unresolved = graph.addUnresolved({
                  reason: 'dynamic-registry-key',
                  attempted: 'resolves',
                  subject: call.getText(sourceFile),
                  location: span,
                  detail: key.reason,
                });
                graph.addRelationship('resolves', owner, unresolved.id, 'low', {
                  evidence: 'ts-program',
                  spans: [span],
                });
                continue;
              }

              const registryKey = graph.addRegistryKey(key.name, rule.registry, key.keyType);
              graph.addRelationship('resolves', owner, registryKey.id, 'high', {
                evidence: 'config',
                spans: [span],
                metadata: { injection: 'constructor' },
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}
