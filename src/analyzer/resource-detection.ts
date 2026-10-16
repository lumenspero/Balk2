import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { ConnectionGraph } from '../graph.js';
import { normalizePath } from '../graph.js';
import { detectResourceKind } from '../data/formats.js';
import type { ResourceKind } from '../types.js';
import { enclosingOwner } from './owner.js';
import type { RepositoryProgram } from './repository-program.js';
import type { ResourceProtocol } from './resource-protocols.js';
import { snippetOf, spanOf } from './spans.js';
import { resolveStaticKey } from './static-keys.js';

/** A resource a path names, once it is confirmed to be a file inside the repository. */
interface ResolvedResource {
  readonly path: string;
  readonly kind: ResourceKind;
}

/**
 * Resource detection: templates, stylesheets and schemas that code uses.
 *
 * - A static import of a resource file (`import './app.css'`, `import tpl from './page.html?raw'`)
 *   links the importing file to the resource with `mechanism: 'import'`. Only relative specifiers
 *   count, since a bare specifier is a package.
 * - A configured loader call (`protocols.resources`) links its enclosing owner to the resource it
 *   names, with `mechanism: 'loader'`.
 * - A loader path that is not a constant is a `dynamic-resource-specifier` observation.
 *
 * A path that names no file inside the repository is silent, the same rule external modules
 * follow. The check is against the disk under the repository root, because the TypeScript program
 * holds only code files.
 */
export function collectResourceRelationships(
  repository: RepositoryProgram,
  graph: ConnectionGraph,
  protocols: readonly ResourceProtocol[],
): void {
  const byName = new Map(protocols.map((protocol) => [protocol.function, protocol]));

  for (const [filePath, sourceFile] of sortedFiles(repository)) {
    if (sourceFile.isDeclarationFile) continue;

    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        recordImport(
          node.moduleSpecifier.text,
          filePath,
          spanOf(node, filePath),
          repository,
          graph,
        );
      } else if (byName.size > 0 && ts.isCallExpression(node)) {
        inspectLoaderCall(node, filePath, byName, repository, graph);
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
}

function recordImport(
  specifier: string,
  filePath: string,
  span: ReturnType<typeof spanOf>,
  repository: RepositoryProgram,
  graph: ConnectionGraph,
): void {
  const resource = resolveResource(specifier, filePath, repository, 'import');
  if (!resource) return;

  const node = graph.addResource(resource.path, resource.kind);
  graph.addRelationship('usesResource', filePath, node.id, 'high', {
    evidence: 'ast',
    spans: [span],
    metadata: { resourceKind: resource.kind, mechanism: 'import' },
  });
}

function inspectLoaderCall(
  call: ts.CallExpression,
  filePath: string,
  byName: ReadonlyMap<string, ResourceProtocol>,
  repository: RepositoryProgram,
  graph: ConnectionGraph,
): void {
  const callee = call.expression;
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : undefined;
  const protocol = name !== undefined ? byName.get(name) : undefined;
  const argument = protocol ? call.arguments[protocol.specifierArg] : undefined;
  if (!argument) return;

  const key = resolveStaticKey(argument, repository.checker);
  if (key.kind === 'not-a-name') return;

  const span = spanOf(call, filePath);
  const owner = enclosingOwner(call, filePath);

  if (key.kind === 'dynamic') {
    const unresolved = graph.addUnresolved({
      reason: 'dynamic-resource-specifier',
      attempted: 'usesResource',
      subject: snippetOf(call),
      location: span,
      detail: key.reason,
    });
    graph.addRelationship('usesResource', owner, unresolved.id, 'low', {
      evidence: 'ts-program',
      spans: [span],
    });
    return;
  }

  const resource = resolveResource(key.name, filePath, repository, 'loader');
  if (!resource) return;

  const node = graph.addResource(resource.path, resource.kind);
  graph.addRelationship('usesResource', owner, node.id, 'high', {
    evidence: 'config',
    spans: [span],
    metadata: { resourceKind: resource.kind, mechanism: 'loader' },
  });
}

/**
 * The resource a specifier names, or undefined. An import must be relative; a loader path may be
 * relative to the calling file or, without a leading dot, relative to the repository root. A query
 * suffix (`?raw`, `?url`) is ignored. The path must be a file inside the repository and must have
 * a resource kind.
 */
function resolveResource(
  specifier: string,
  fromFile: string,
  repository: RepositoryProgram,
  mode: 'import' | 'loader',
): ResolvedResource | undefined {
  const bare = stripQuery(specifier);
  const isRelative = bare.startsWith('.');
  if (mode === 'import' && !isRelative) return undefined;

  const base = isRelative ? path.posix.dirname(normalizePath(fromFile)) : '.';
  const joined = path.posix.normalize(path.posix.join(base, bare));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined))
    return undefined;

  const kind = detectResourceKind(joined);
  if (!kind) return undefined;

  const absolute = path.join(repository.rootDir, ...joined.split('/'));
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return undefined;

  return { path: normalizePath(joined), kind };
}

function stripQuery(specifier: string): string {
  const query = specifier.indexOf('?');
  return query < 0 ? specifier : specifier.slice(0, query);
}

function sortedFiles(repository: RepositoryProgram): [string, ts.SourceFile][] {
  return [...repository.sourceFiles].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}
