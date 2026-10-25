import * as fs from 'fs';
import { posix } from 'path';
import type { ConnectionGraph } from '../../graph.js';
import type { PackageNode } from '../../types.js';
import { nearestPackageDir, resolveCommand, type CommandEnvironment } from './commands.js';
import type { ProcessCall } from './types.js';

/**
 * Process execution (V3 Phase 14.5). Each call that starts a process becomes an `executes` edge
 * from its owner to the repository script it runs. A call whose command is not a literal is an
 * observation, and a script that is not in the repository is an unresolved module path.
 *
 * The owner is the enclosing function when the graph has it, and the file otherwise.
 */
export function connectProcesses(
  graph: ConnectionGraph,
  calls: readonly ProcessCall[],
  env: CommandEnvironment,
): void {
  for (const call of calls) {
    const owner = graph.hasSymbol(call.owner) ? call.owner : call.file;
    if (!graph.hasFile(owner) && !graph.hasSymbol(owner)) continue;

    const evidence = call.evidence ?? 'ast';
    if (call.argv === null) {
      const unresolved = graph.addUnresolved({
        reason: 'dynamic-command',
        attempted: 'executes',
        subject: call.callee,
        location: call.span,
        detail: 'the command is not a literal, so the script it runs cannot be followed',
      });
      graph.addRelationship('executes', owner, unresolved.id, 'low', {
        evidence,
        spans: [call.span],
      });
      continue;
    }

    const base = call.workingDir ?? nearestPackageDir(call.file, env.files);
    const resolution = resolveCommand(call.argv, env, base);
    if (resolution === undefined) continue;
    if (resolution.kind === 'unresolved') {
      const unresolved = graph.addUnresolved({
        reason: 'unresolved-module-path',
        attempted: 'executes',
        subject: resolution.subject,
        location: call.span,
        detail: 'the script this command runs is not in the repository',
      });
      graph.addRelationship('executes', owner, unresolved.id, 'low', {
        evidence,
        spans: [call.span],
      });
      continue;
    }

    if (!graph.hasFile(resolution.file)) continue;
    graph.addRelationship('executes', owner, resolution.file, 'high', {
      evidence,
      spans: [call.span],
      metadata: { mechanism: 'process' },
    });
  }
}

/**
 * The command environment for one build: the repository's files, its package.json scripts, and
 * its Cargo binaries. Cargo binary names use `_` for `-`, as the package nodes do.
 */
export function commandEnvironment(
  rootDir: string,
  files: readonly string[],
  packages: readonly PackageNode[],
): CommandEnvironment {
  const scripts = new Map<string, Readonly<Record<string, string>> | undefined>();
  return {
    files: new Set(files),
    npmScripts: (packageDir): Readonly<Record<string, string>> | undefined => {
      if (!scripts.has(packageDir)) scripts.set(packageDir, readScripts(rootDir, packageDir));
      return scripts.get(packageDir);
    },
    binaryFile: (name): string | undefined => {
      const codeName = name.replace(/-/g, '_');
      const node = packages.find(
        (p) => p.ecosystem === 'cargo' && p.target === 'bin' && p.name === codeName,
      );
      return node?.roots[0];
    },
  };
}

function readScripts(
  rootDir: string,
  packageDir: string,
): Readonly<Record<string, string>> | undefined {
  try {
    const doc = JSON.parse(
      fs.readFileSync(`${rootDir}/${posix.join(packageDir, 'package.json')}`, 'utf8'),
    ) as { scripts?: unknown };
    if (typeof doc.scripts !== 'object' || doc.scripts === null) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(doc.scripts)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return undefined;
  }
}
