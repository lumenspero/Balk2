import * as ts from 'typescript';
import type { RegistryInjectionFact } from '../facts/types.js';
import { ownerOf } from './owner.js';
import type { RepositoryProgram } from './repository-program.js';
import { keyFactOf, resolveRegistryKey } from './registry-keys.js';
import type { RegistryParameterDecoratorRule } from './registry-protocols.js';
import { spanOf } from './spans.js';

/**
 * Front end for constructor parameter injection: `constructor(@Inject(UserRepo) repo: UserRepo)`.
 *
 * The enclosing class depends on the key, so each decorator becomes an injection fact with the
 * class as its owner. The key is read with the same rules as a lookup, so a class token agrees
 * with its registration. Only constructor parameters are read; method and property injection are
 * not. Reads only; the engine decides what each one links to.
 */
export function extractInjectionFacts(
  repository: RepositoryProgram,
  rules: readonly RegistryParameterDecoratorRule[],
): RegistryInjectionFact[] {
  if (rules.length === 0) return [];
  const rulesByName = new Map(rules.map((rule) => [rule.name, rule]));
  const checker = repository.checker;
  const found: RegistryInjectionFact[] = [];

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

              const key = resolveRegistryKey(keyArgument, checker, 'typed');
              if (key.kind === 'not-a-name') continue;

              found.push({
                kind: 'registry-injection',
                filePath,
                span: spanOf(call, filePath),
                owner,
                registry: rule.registry,
                key: keyFactOf(key),
                subject: call.getText(sourceFile),
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return found;
}
