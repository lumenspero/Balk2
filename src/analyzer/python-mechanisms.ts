/**
 * Python mechanisms that the fact-based front end does not produce yet (V3 Phase 5.7a). They move
 * here from python-analyzer.ts unchanged, and are retired in Phases 11 and 12:
 * - data artifact literals on a line (`addDataLiteralsOnLine`);
 * - `importlib.import_module` loads (`inspectImportModuleCalls`);
 * - the owner of each line, which source annotations and loads share (`ownersByLine`);
 * - the path resolution that both use (`resolvePythonImport`).
 */
import type { ConnectionGraph } from '../graph.js';
import { inferDataDirection, addDataRelationship } from '../data/data-analyzer.js';
import { isDataPathLiteral, isNonAccessBefore, pathLiteralsInLine } from './data-literals.js';
import { selfDirectories, selfJoinSpans } from './python-self-dirs.js';

type SelfDirs = ReturnType<typeof selfDirectories>;

/** Data artifact references on one line: a path literal or a `self.<dir>` join naming a data file. */
export function addDataLiteralsOnLine(
  trimmed: string,
  filePath: string,
  selfDirs: SelfDirs,
  graph: ConnectionGraph,
  claimed: (value: string) => boolean = () => false,
): void {
  const selfJoins = selfJoinSpans(trimmed, selfDirs);
  const literals = [
    ...selfJoins.map(({ value, index }) => ({ value, index })),
    ...pathLiteralsInLine(trimmed).filter(
      (lit) => !selfJoins.some((join) => lit.index >= join.index && lit.index < join.end),
    ),
  ];
  for (const { value, index } of literals) {
    // A literal the AST catalog has already resolved takes its edge from there (Phase 11.2).
    if (claimed(value)) continue;
    if (isDataPathLiteral(value) && !isNonAccessBefore(trimmed.slice(0, index))) {
      const direction = inferDataDirection(trimmed);
      addDataRelationship(
        filePath,
        value,
        direction.type,
        graph,
        direction.certain ? 'high' : 'low',
      );
    }
  }
}

/**
 * The owner id of every line of a Python file, indexed by 0-based line index: the enclosing
 * `file:Class.method` or `file:function`, or the file itself at top level. This is the owner
 * `analyzeFile` records for the calls on that line, so a source directive can be checked against
 * the same owner the analyzer uses.
 */
export function ownersByLine(content: string, filePath: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const owners: string[] = [];
  let activeCaller: string = filePath;
  let activeClass: string | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const indent = line.search(/\S/);
      if (indent === 0 && !line.startsWith('class ') && !line.startsWith('@')) {
        activeClass = undefined;
        activeCaller = filePath;
      }

      const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)/);
      if (classMatch && indent === 0) {
        activeClass = classMatch[1]!;
        activeCaller = `${filePath}:${activeClass}`;
      }

      const defMatch = trimmed.match(/^def\s+([a-zA-Z0-9_]+)/);
      if (defMatch) {
        const fnName = defMatch[1]!;
        if (indent === 0) {
          activeCaller = `${filePath}:${fnName}`;
        } else if (activeClass) {
          activeCaller = `${filePath}:${activeClass}.${fnName}`;
        }
      }
    }
    owners.push(activeCaller);
  }
  return owners;
}

// ── importlib ───────────────────────────────────────────────────────

/**
 * `importlib.import_module(x)` or a bare `import_module(x)` bound by a from-import. A string
 * literal names a module: an internal one is an `imports` edge with `loadKind: import-module`, an
 * external or missing one is silent. Any other argument is a `dynamic-module-specifier` observation,
 * linked from the owner at low confidence. `line` is the 1-based line the call is written on.
 */
export function inspectImportModuleCalls(
  trimmed: string,
  owner: string,
  filePath: string,
  line: number,
  importModuleNames: ReadonlySet<string>,
  knownFiles: ReadonlySet<string> | undefined,
  graph: ConnectionGraph,
): void {
  const pattern = /(?:\bimportlib\.import_module|\b([a-zA-Z_][a-zA-Z0-9_]*))\s*\(/g;
  for (const match of trimmed.matchAll(pattern)) {
    const bare = match[1];
    if (bare !== undefined && !importModuleNames.has(bare)) continue;

    const argStart = (match.index ?? 0) + match[0].length;
    const argument = firstArgument(trimmed.slice(argStart));
    if (argument === undefined) continue;

    const literal = /^(['"])([^'"]+)\1$/.exec(argument);
    if (literal) {
      const moduleName = literal[2]!;
      const targetFile = resolvePythonImport(filePath, moduleName, knownFiles);
      if (targetFile) {
        graph.addRelationship('imports', owner, targetFile, 'high', {
          evidence: 'ts-program',
          metadata: { loadKind: 'import-module' },
        });
      }
      continue;
    }

    const column = (match.index ?? 0) + 1;
    const unresolved = graph.addUnresolved({
      reason: 'dynamic-module-specifier',
      attempted: 'imports',
      subject: `${match[0]}${argument})`,
      location: {
        filePath,
        startLine: line,
        startColumn: column,
        endLine: line,
        endColumn: column + match[0].length,
      },
      detail: 'the module name is not a string literal',
    });
    graph.addRelationship('imports', owner, unresolved.id, 'low', {
      evidence: 'heuristic',
      metadata: { loadKind: 'import-module' },
    });
  }
}

/** The text of the first argument in a call's remainder, up to a top-level comma or `)`. */
function firstArgument(rest: string): string | undefined {
  let depth = 0;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return rest.slice(0, i).trim() || undefined;
      depth--;
    } else if (ch === ',' && depth === 0) {
      return rest.slice(0, i).trim() || undefined;
    }
  }
  return undefined;
}

// ── Helpers ─────────────────────────────────────────────────────────

export function resolvePythonImport(
  fromFile: string,
  specifier: string,
  knownFiles?: ReadonlySet<string>,
): string | undefined {
  if (!knownFiles) return undefined;

  // Convert Python module dot notation to path e.g. foo.bar -> foo/bar.py or foo/bar/__init__.py
  const pathSpec = specifier.replace(/\./g, '/');

  // Relative import e.g. .util or ..data
  if (specifier.startsWith('.')) {
    const parts = fromFile.split('/');
    parts.pop(); // remove file name
    // Count leading dots
    let dots = 0;
    for (const char of specifier) {
      if (char === '.') dots++;
      else break;
    }
    for (let i = 1; i < dots; i++) parts.pop();
    const remaining = specifier.slice(dots).replace(/\./g, '/');
    if (remaining) parts.push(remaining);

    const basePath = parts.join('/');
    return checkPyCandidates(basePath, knownFiles);
  }

  // Absolute / repo import e.g. scripts/collect or scripts.collect
  const candidate1 = `${pathSpec}.py`;
  if (knownFiles.has(candidate1)) return candidate1;

  const candidate2 = `${pathSpec}/__init__.py`;
  if (knownFiles.has(candidate2)) return candidate2;

  // Check relative from source file directory
  const fromDir = fromFile.split('/').slice(0, -1).join('/');
  const relFromDir = fromDir ? `${fromDir}/${pathSpec}` : pathSpec;
  return checkPyCandidates(relFromDir, knownFiles);
}

function checkPyCandidates(basePath: string, knownFiles: ReadonlySet<string>): string | undefined {
  const p1 = `${basePath}.py`;
  if (knownFiles.has(p1)) return p1;

  const p2 = `${basePath}/__init__.py`;
  if (knownFiles.has(p2)) return p2;

  if (knownFiles.has(basePath)) return basePath;

  return undefined;
}

/**
 * The non-fact mechanisms of one file (V3 Phase 5.7b): data artifact literals on every line, then
 * importlib loads with their owners. Retired in Phases 11 and 12.
 */
export function addPythonMechanisms(
  filePath: string,
  content: string,
  graph: ConnectionGraph,
  knownFiles: ReadonlySet<string>,
  claimed: (line: number, value: string) => boolean = () => false,
): void {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const selfDirs = selfDirectories(lines);

  // Names bound to importlib's import_module: `from importlib import import_module [as x]`.
  const importModuleNames = new Set<string>();
  for (const line of lines) {
    const trimmed = line.trim();
    const fromImport = /^from\s+([a-zA-Z0-9_.]+)\s+import\s+(.+)/.exec(trimmed);
    if (fromImport?.[1] !== 'importlib') continue;
    for (const item of (fromImport[2] ?? '').split(',')) {
      const parts = item.trim().split(/\s+as\s+/);
      if (parts[0]?.trim() === 'import_module') {
        importModuleNames.add((parts[1] ?? parts[0] ?? '').trim());
      }
    }
  }

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    addDataLiteralsOnLine(trimmed, filePath, selfDirs, graph, (value) => claimed(index + 1, value));
  }

  const owners = ownersByLine(content, filePath);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    inspectImportModuleCalls(
      trimmed,
      owners[i] ?? filePath,
      filePath,
      i + 1,
      importModuleNames,
      knownFiles,
      graph,
    );
  }
}
