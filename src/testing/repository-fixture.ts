import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { createRepositoryProgram, type RepositoryProgram } from '../analyzer/repository-program.js';

/** A throwaway repository on disk, analyzed through the same program model as production. */
export interface RepositoryFixture {
  readonly repository: RepositoryProgram;
  /** Delete the files. Call from `afterAll`/`afterEach`. */
  cleanup(): void;
}

/**
 * Write `files` (repository-relative path to content) into a temporary directory and open
 * them as a repository. `compilerOptions`, when given, becomes the fixture's tsconfig.
 */
export function createRepositoryFixture(
  files: Readonly<Record<string, string>>,
  compilerOptions?: Readonly<Record<string, unknown>>,
): RepositoryFixture {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'balk2-fixture-'));

  if (compilerOptions) {
    fs.writeFileSync(path.join(rootDir, 'tsconfig.json'), JSON.stringify({ compilerOptions }));
  }
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(rootDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }

  return {
    repository: createRepositoryProgram({ rootDir, filePaths: Object.keys(files).sort() }),
    cleanup: (): void => fs.rmSync(rootDir, { recursive: true, force: true }),
  };
}

/** The first argument of every call to `callee(...)` in a file, in source order. */
export function callArguments(
  repository: RepositoryProgram,
  filePath: string,
  callee = 'probe',
): ts.Expression[] {
  const sourceFile = repository.sourceFiles.get(filePath);
  if (!sourceFile) throw new Error(`No source file ${filePath}`);

  const found: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === callee &&
      node.arguments[0]
    ) {
      found.push(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}
