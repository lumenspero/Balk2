import type { Analyzer, AnalyzerOptions } from './types.js';
import type { ConnectionGraph } from '../graph.js';
import { normalizePath } from '../graph.js';
import type { SymbolType } from '../types.js';
import { inferDataDirection, addDataRelationship } from '../data/data-analyzer.js';
import { isDataPathLiteral, isNonAccessBefore, pathLiteralsInLine } from './data-literals.js';
import { selfDirectories, selfJoinSpans } from './python-self-dirs.js';

export class PythonAnalyzer implements Analyzer {
  readonly name = 'PythonAnalyzer';
  readonly supportedExtensions: readonly string[] = ['.py'];

  canAnalyze(filePath: string): boolean {
    return normalizePath(filePath).toLowerCase().endsWith('.py');
  }

  analyzeFile(
    filePath: string,
    content: string,
    graph: ConnectionGraph,
    options?: AnalyzerOptions,
  ): void {
    const normalizedPath = normalizePath(filePath);

    // 1. Add file node
    graph.addFile(normalizedPath, 'python');

    const knownFiles = options?.knownFiles ? toSet(options.knownFiles) : undefined;
    const lines = content.replace(/\r\n/g, '\n').split('\n');

    // Directories stored on self, so self.<attr> / "name" can be joined into a full path.
    const selfDirs = selfDirectories(lines);

    // Context tracking
    const importsMap = new Map<string, { targetFile: string; importedName: string }>();
    const topLevelSymbols = new Map<string, { id: string; type: SymbolType }>();
    let currentClass: string | undefined;
    // Names bound to importlib's import_module: `from importlib import import_module [as x]`.
    const importModuleNames = new Set<string>();

    // Pass 1: Imports, Classes, Functions, Methods, Variables & Exports
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();

      // Skip empty lines & comments
      if (!trimmed || trimmed.startsWith('#')) continue;

      // ── Data Artifact References in Line ──────────────────────────
      const selfJoins = selfJoinSpans(trimmed, selfDirs);
      const literals = [
        ...selfJoins.map(({ value, index }) => ({ value, index })),
        ...pathLiteralsInLine(trimmed).filter(
          (lit) => !selfJoins.some((join) => lit.index >= join.index && lit.index < join.end),
        ),
      ];
      for (const { value, index } of literals) {
        if (isDataPathLiteral(value) && !isNonAccessBefore(trimmed.slice(0, index))) {
          const direction = inferDataDirection(trimmed);
          addDataRelationship(
            normalizedPath,
            value,
            direction.type,
            graph,
            direction.certain ? 'high' : 'low',
          );
        }
      }

      const indent = line.search(/\S/);

      // Reset current class context if at root indentation and not inside a class declaration
      if (indent === 0 && !line.startsWith('class ') && !line.startsWith('@')) {
        currentClass = undefined;
      }

      // ── Imports ───────────────────────────────────────────────────
      // import foo / import foo.bar as fb
      const importMatch = trimmed.match(/^import\s+([a-zA-Z0-9_.]+)(?:\s+as\s+([a-zA-Z0-9_]+))?/);
      if (importMatch && !trimmed.startsWith('from')) {
        const moduleName = importMatch[1]!;
        const alias = importMatch[2] ?? moduleName.split('.').pop()!;
        const targetFile = resolvePythonImport(normalizedPath, moduleName, knownFiles);
        if (targetFile) {
          graph.addRelationship('imports', normalizedPath, targetFile);
          importsMap.set(alias, { targetFile, importedName: alias });
        }
        continue;
      }

      // from foo import bar, baz / from .util import format
      const fromImportMatch = trimmed.match(/^from\s+([a-zA-Z0-9_.]+)\s+import\s+(.+)/);
      if (fromImportMatch) {
        const moduleSpec = fromImportMatch[1]!;
        const importedItemsStr = fromImportMatch[2]!;

        if (moduleSpec === 'importlib') {
          for (const item of importedItemsStr.split(',')) {
            const parts = item.trim().split(/\s+as\s+/);
            if (parts[0]?.trim() === 'import_module') {
              importModuleNames.add((parts[1] ?? parts[0]).trim());
            }
          }
        }

        const targetFile = resolvePythonImport(normalizedPath, moduleSpec, knownFiles);

        if (targetFile) {
          graph.addRelationship('imports', normalizedPath, targetFile);

          const items = importedItemsStr.split(',').map((s) => s.trim().split(/\s+as\s+/));
          for (const itemParts of items) {
            const origName = itemParts[0]?.trim();
            const localName = itemParts[1]?.trim() ?? origName;
            if (origName && localName) {
              importsMap.set(localName, { targetFile, importedName: origName });
            }
          }
        }
        continue;
      }

      // ── Class Declarations ────────────────────────────────────────
      const classMatch = trimmed.match(/^class\s+([a-zA-Z0-9_]+)(?:\(([^)]+)\))?:/);
      if (classMatch && indent === 0) {
        const className = classMatch[1]!;
        currentClass = className;
        const classSym = graph.addSymbol(normalizedPath, className, 'class');
        topLevelSymbols.set(className, { id: classSym.id, type: 'class' });

        if (!className.startsWith('_')) {
          graph.addRelationship('exports', normalizedPath, classSym.id);
        }

        // Extends base class
        if (classMatch[2]) {
          const bases = classMatch[2].split(',').map((b) => b.trim());
          for (const base of bases) {
            if (base && base !== 'object') {
              const imported = importsMap.get(base);
              const target = imported ? `${imported.targetFile}:${imported.importedName}` : base;
              graph.addRelationship('extends', classSym.id, target);
            }
          }
        }
        continue;
      }

      // ── Function & Method Declarations ───────────────────────────
      const defMatch = trimmed.match(/^def\s+([a-zA-Z0-9_]+)\s*\(/);
      if (defMatch) {
        const funcName = defMatch[1]!;

        if (indent === 0) {
          // Root function
          const funcSym = graph.addSymbol(normalizedPath, funcName, 'function');
          topLevelSymbols.set(funcName, { id: funcSym.id, type: 'function' });
          if (!funcName.startsWith('_')) {
            graph.addRelationship('exports', normalizedPath, funcSym.id);
          }
        } else if (currentClass && indent > 0) {
          // Method inside class
          const fullMethodName = `${currentClass}.${funcName}`;
          const methodSym = graph.addSymbol(normalizedPath, fullMethodName, 'method');
          topLevelSymbols.set(fullMethodName, { id: methodSym.id, type: 'method' });
        }
        continue;
      }

      // ── Top-level Constants & Variables ──────────────────────────
      const varMatch = trimmed.match(/^([A-Z0-9_]+)\s*=/);
      if (varMatch && indent === 0) {
        const varName = varMatch[1]!;
        const varSym = graph.addSymbol(normalizedPath, varName, 'constant');
        topLevelSymbols.set(varName, { id: varSym.id, type: 'constant' });
        if (!varName.startsWith('_')) {
          graph.addRelationship('exports', normalizedPath, varSym.id);
        }
      }
    }

    // Pass 2: Function & Method Call Relationships, and importlib module loads.
    // Owners come from ownersByLine, the same function the source-annotation collector uses.
    const owners = ownersByLine(content, normalizedPath);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const activeCallerId = owners[i] ?? normalizedPath;

      // importlib.import_module(...) and import_module(...) after a from-import
      inspectImportModuleCalls(
        trimmed,
        activeCallerId,
        normalizedPath,
        i + 1,
        importModuleNames,
        knownFiles,
        graph,
      );

      // Detect function calls in line
      const callMatches = trimmed.matchAll(/\b([a-zA-Z0-9_]+)\s*\(/g);
      for (const cm of callMatches) {
        const calleeName = cm[1]!;
        if (
          [
            'def',
            'class',
            'if',
            'while',
            'for',
            'print',
            'open',
            'range',
            'len',
            'str',
            'int',
            'dict',
            'list',
          ].includes(calleeName)
        ) {
          continue;
        }

        const imported = importsMap.get(calleeName);
        if (imported) {
          const targetSymbolId = `${imported.targetFile}:${imported.importedName}`;
          graph.addRelationship('calls', activeCallerId, targetSymbolId);
        } else {
          const localSym = topLevelSymbols.get(calleeName);
          if (localSym && localSym.id !== activeCallerId) {
            graph.addRelationship('calls', activeCallerId, localSym.id);
          }
        }
      }
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
function inspectImportModuleCalls(
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

function resolvePythonImport(
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

function toSet(knownFiles: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  if (knownFiles instanceof Set) return knownFiles;
  return new Set((knownFiles as readonly string[]).map(normalizePath));
}
