import type * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import { runRegistryEngine } from '../facts/registry-engine.js';
import { applyRegistryEdges } from './registry-apply.js';
import { extractCallFacts } from './registry-facts.js';
import { extractInjectionFacts } from './registry-injection.js';
import { RegistryProtocolCatalog, type RegistryProtocolOptions } from './registry-protocols.js';
import type { RepositoryProgram } from './repository-program.js';
import { extractDeclarationFacts } from './registry-sources.js';

/**
 * Registry pass: map registry calls (`container.set('user', User)`, `container.get('user')`,
 * `container.get(UserService)`, `container.resolve<UserService>()`, `router.navigate('/users')`)
 * and dictionary assignments (`handlers[404] = NotFound`) onto registry keys.
 *
 * The front ends read the source (`registry-sources.ts`, `registry-injection.ts`,
 * `registry-facts.ts`), the engine decides what each fact links to (`facts/registry-engine.ts`),
 * and `registry-apply.ts` writes the result in the order it was found.
 *
 * A registration links the key to the symbol it maps to with `registers`. A lookup links its caller
 * to the key with `resolves` or `routesTo`. A key is scoped by the identity of its registry, so the
 * same name in two registries stays two keys. A dynamic key, or a receiver whose identity cannot be
 * read, becomes an unresolved observation rather than a guessed edge.
 *
 * A receiver that is only shaped like a registry (a Map or Set) is trusted as a registry only when
 * there is evidence it holds repository symbols: a declared key, a symbol-valued registration into
 * the same registry, or a configured name or type. For an untrusted receiver, a dynamic key or an
 * unknown identity produces no observation, so a private index does not report noise. A static key
 * on an untrusted receiver still forms its edge, as a lookup into a registry nobody declares.
 *
 * Runs after the per-file pass, so the symbols a registration maps to already exist in the graph.
 * Every read happens before any write, which is safe because registry writes never change which
 * symbols or files the graph holds.
 */
export function collectRegistryRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  options: RegistryProtocolOptions = {},
  claimed: ReadonlySet<ts.Node> = new Set(),
): void {
  const catalog = new RegistryProtocolCatalog(options);
  const declarations = extractDeclarationFacts(repository, graph, catalog, options);
  const injections = extractInjectionFacts(repository, options.parameterDecorators ?? []);
  const calls = extractCallFacts(repository, graph, catalog, claimed);

  const edges = runRegistryEngine({
    configured: declarations.configured,
    facts: [...declarations.declarations, ...injections, ...calls],
  });
  applyRegistryEdges(graph, edges);
}
