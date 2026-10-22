import type { Analyzer, AnalyzerOptions } from './types.js';
import type { ConnectionGraph } from '../graph.js';
import { normalizePath } from '../graph.js';
import type { SymbolType } from '../types.js';
import { selfDirectories } from './python-self-dirs.js';
import {
  addDataLiteralsOnLine,
  inspectImportModuleCalls,
  ownersByLine,
  resolvePythonImport,
} from './python-mechanisms.js';

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

      addDataLiteralsOnLine(trimmed, normalizedPath, selfDirs, graph);

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

function toSet(knownFiles: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  if (knownFiles instanceof Set) return knownFiles;
  return new Set((knownFiles as readonly string[]).map(normalizePath));
}
