import * as path from 'node:path';
import * as ts from 'typescript';
import { normalizePath } from '../graph.js';
import { compareStrings } from '../relationship-types.js';
import { resolveImportPath } from './resolver.js';

export type ModuleResolutionKind = 'internal' | 'external' | 'unresolved';

export interface ResolvedModule {
  readonly fromFile: string;
  readonly specifier: string;
  readonly kind: ModuleResolutionKind;
  readonly path?: string;
  readonly resolution: 'typescript' | 'fallback' | 'unresolved';
}

/** A syntax error TypeScript recovered from. Analysis of that file may be incomplete. */
export interface SyntaxErrorNote {
  readonly path: string;
  /** 1-based */
  readonly line: number;
  /** 1-based */
  readonly column: number;
  readonly message: string;
}

export interface RepositoryProgramOptions {
  /** Absolute repository root containing optional tsconfig.json. */
  readonly rootDir: string;
  /** Repository-relative JS/TS paths that belong to the analysis session. */
  readonly filePaths: readonly string[];
  /**
   * A compiler host to read files through. Production leaves this unset; tests pass one that keeps
   * the parsed standard library between programs.
   */
  readonly host?: ts.CompilerHost;
}

/**
 * A single parsed JS/TS repository plus TypeScript's module-resolution settings.
 * The session is intentionally analysis-only: no diagnostics are emitted into the
 * V1 graph until V2's richer graph schema is introduced.
 */
export class RepositoryProgram {
  readonly rootDir: string;
  readonly compilerOptions: ts.CompilerOptions;
  readonly sourceFiles: ReadonlyMap<string, ts.SourceFile>;
  readonly checker: ts.TypeChecker;

  private readonly knownFiles: ReadonlySet<string>;
  private readonly host: ts.ModuleResolutionHost;
  private readonly program: ts.Program;
  private readonly optionsByDir = new Map<string, ts.CompilerOptions>();

  constructor(options: RepositoryProgramOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.knownFiles = new Set(options.filePaths.map(normalizePath));
    this.compilerOptions = loadCompilerOptions(this.rootDir);
    this.host = ts.sys;

    const rootNames = [...this.knownFiles].map((filePath) => path.resolve(this.rootDir, filePath));
    const program = ts.createProgram({
      rootNames,
      options: this.compilerOptions,
      ...(options.host ? { host: options.host } : {}),
    });
    this.program = program;
    this.checker = program.getTypeChecker();
    const sourceFiles = new Map<string, ts.SourceFile>();

    for (const sourceFile of program.getSourceFiles()) {
      const relative = toRepositoryPath(this.rootDir, sourceFile.fileName);
      if (relative && this.knownFiles.has(relative)) sourceFiles.set(relative, sourceFile);
    }

    this.sourceFiles = sourceFiles;
  }

  /**
   * Syntax errors recorded for each analyzed file, sorted by path, then position. TypeScript
   * recovers from these and still builds a tree, so the graph is produced but may be incomplete.
   */
  syntaxErrors(): SyntaxErrorNote[] {
    const notes: SyntaxErrorNote[] = [];
    for (const [filePath, sourceFile] of this.sourceFiles) {
      for (const diagnostic of this.program.getSyntacticDiagnostics(sourceFile)) {
        const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
        notes.push({
          path: filePath,
          line: (position?.line ?? 0) + 1,
          column: (position?.character ?? 0) + 1,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        });
      }
    }
    return notes.sort(
      (a, b) => compareStrings(a.path, b.path) || a.line - b.line || a.column - b.column,
    );
  }

  /**
   * A relative specifier naming a JSON file that exists in the repository. Resolved directly, so it
   * does not depend on TypeScript's resolveJsonModule setting.
   */
  private resolveDataFile(containingFile: string, specifier: string): string | undefined {
    if (!specifier.startsWith('.') || !specifier.toLowerCase().endsWith('.json')) return undefined;
    const target = path.resolve(path.dirname(containingFile), specifier);
    const repoPath = toRepositoryPath(this.rootDir, target);
    if (!repoPath || !ts.sys.fileExists(target)) return undefined;
    return repoPath;
  }

  /**
   * Module-resolution options for a containing file. A nested `tsconfig.json` between the file
   * and the repository root applies to its own directory tree, as TypeScript's project model does
   * (its `paths` and `baseUrl` are relative to it). Otherwise the root options apply.
   */
  private optionsFor(containingFile: string): ts.CompilerOptions {
    const chain: string[] = [];
    let dir = path.dirname(containingFile);
    let options: ts.CompilerOptions = this.compilerOptions;
    for (;;) {
      const cached = this.optionsByDir.get(dir);
      if (cached) {
        options = cached;
        break;
      }
      chain.push(dir);
      if (dir === this.rootDir || !dir.startsWith(this.rootDir + path.sep)) break;
      const configPath = path.join(dir, 'tsconfig.json');
      if (ts.sys.fileExists(configPath)) {
        options = readCompilerOptions(configPath) ?? this.compilerOptions;
        break;
      }
      dir = path.dirname(dir);
    }
    for (const entry of chain) this.optionsByDir.set(entry, options);
    return options;
  }

  resolveModule(fromFile: string, specifier: string): ResolvedModule {
    const normalizedFrom = normalizePath(fromFile);
    const containingFile = path.resolve(this.rootDir, normalizedFrom);
    const dataFile = this.resolveDataFile(containingFile, specifier);
    if (dataFile) {
      return {
        fromFile: normalizedFrom,
        specifier,
        kind: 'internal',
        path: dataFile,
        resolution: 'fallback',
      };
    }
    const resolved = ts.resolveModuleName(
      specifier,
      containingFile,
      this.optionsFor(containingFile),
      this.host,
    ).resolvedModule;

    if (resolved) {
      const resolvedPath = toRepositoryPath(this.rootDir, resolved.resolvedFileName);
      if (resolvedPath && this.knownFiles.has(resolvedPath)) {
        return {
          fromFile: normalizedFrom,
          specifier,
          kind: 'internal',
          path: resolvedPath,
          resolution: 'typescript',
        };
      }

      return {
        fromFile: normalizedFrom,
        specifier,
        kind: 'external',
        resolution: 'typescript',
      };
    }

    const fallback = resolveImportPath(normalizedFrom, specifier, this.knownFiles);
    if (fallback && this.knownFiles.has(fallback)) {
      return {
        fromFile: normalizedFrom,
        specifier,
        kind: 'internal',
        path: fallback,
        resolution: 'fallback',
      };
    }

    return {
      fromFile: normalizedFrom,
      specifier,
      kind: specifier.startsWith('.') || specifier.startsWith('/') ? 'unresolved' : 'external',
      resolution: 'unresolved',
    };
  }
}

export function createRepositoryProgram(options: RepositoryProgramOptions): RepositoryProgram {
  return new RepositoryProgram(options);
}

function loadCompilerOptions(rootDir: string): ts.CompilerOptions {
  const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return defaultCompilerOptions();
  return readCompilerOptions(configPath) ?? defaultCompilerOptions();
}

/** Undefined when the file cannot be read or has option errors. */
function readCompilerOptions(configPath: string): ts.CompilerOptions | undefined {
  const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (readResult.error) return undefined;

  const parsed = ts.parseJsonConfigFileContent(readResult.config, ts.sys, path.dirname(configPath));
  if (parsed.errors.length > 0) return undefined;

  return {
    ...defaultCompilerOptions(),
    ...parsed.options,
    noEmit: true,
    allowJs: true,
  };
}

function defaultCompilerOptions(): ts.CompilerOptions {
  return {
    allowJs: true,
    checkJs: false,
    module: ts.ModuleKind.Node16,
    moduleResolution: ts.ModuleResolutionKind.Node16,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
  };
}

function toRepositoryPath(rootDir: string, fileName: string): string | undefined {
  const relative = path.relative(rootDir, fileName);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return normalizePath(relative);
}
