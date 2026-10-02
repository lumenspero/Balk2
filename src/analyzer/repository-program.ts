import * as path from 'node:path';
import * as ts from 'typescript';
import { normalizePath } from '../graph.js';
import { resolveImportPath } from './resolver.js';

export type ModuleResolutionKind = 'internal' | 'external' | 'unresolved';

export interface ResolvedModule {
  readonly fromFile: string;
  readonly specifier: string;
  readonly kind: ModuleResolutionKind;
  readonly path?: string;
  readonly resolution: 'typescript' | 'fallback' | 'unresolved';
}

export interface RepositoryProgramOptions {
  /** Absolute repository root containing optional tsconfig.json. */
  readonly rootDir: string;
  /** Repository-relative JS/TS paths that belong to the analysis session. */
  readonly filePaths: readonly string[];
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

  private readonly knownFiles: ReadonlySet<string>;
  private readonly host: ts.ModuleResolutionHost;

  constructor(options: RepositoryProgramOptions) {
    this.rootDir = path.resolve(options.rootDir);
    this.knownFiles = new Set(options.filePaths.map(normalizePath));
    this.compilerOptions = loadCompilerOptions(this.rootDir);
    this.host = ts.sys;

    const rootNames = [...this.knownFiles].map((filePath) => path.resolve(this.rootDir, filePath));
    const program = ts.createProgram({ rootNames, options: this.compilerOptions });
    const sourceFiles = new Map<string, ts.SourceFile>();

    for (const sourceFile of program.getSourceFiles()) {
      const relative = toRepositoryPath(this.rootDir, sourceFile.fileName);
      if (relative && this.knownFiles.has(relative)) sourceFiles.set(relative, sourceFile);
    }

    this.sourceFiles = sourceFiles;
  }

  resolveModule(fromFile: string, specifier: string): ResolvedModule {
    const normalizedFrom = normalizePath(fromFile);
    const containingFile = path.resolve(this.rootDir, normalizedFrom);
    const resolved = ts.resolveModuleName(
      specifier,
      containingFile,
      this.compilerOptions,
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

  const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (readResult.error) return defaultCompilerOptions();

  const parsed = ts.parseJsonConfigFileContent(readResult.config, ts.sys, path.dirname(configPath));
  if (parsed.errors.length > 0) return defaultCompilerOptions();

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
