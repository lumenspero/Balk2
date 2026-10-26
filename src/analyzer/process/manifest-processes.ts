import * as fs from 'fs';
import * as path from 'path';
import { posix } from 'path';
import { parse as parseToml } from 'smol-toml';
import type { SourceSpan } from '../../types.js';
import { splitWords } from './commands.js';
import type { ProcessCall } from './types.js';

const MAKEFILE_NAMES = new Set(['makefile', 'gnumakefile']);

export function isMakefile(file: string): boolean {
  return MAKEFILE_NAMES.has(posix.basename(file).toLowerCase());
}

/**
 * The commands that manifests declare (V3 Phase 14.5): `package.json` scripts, Makefile recipes and
 * `[project.scripts]` entries in `pyproject.toml`. Each is owned by its manifest file, with
 * `manifest` evidence, and resolves through the same resolver as code.
 */
export function manifestProcesses(rootDir: string, files: readonly string[]): ProcessCall[] {
  const fileSet = new Set(files);
  const calls: ProcessCall[] = [];
  for (const file of files) {
    const base = posix.basename(file);
    if (base === 'package.json') {
      packageScripts(rootDir, file, calls);
    } else if (base === 'pyproject.toml') {
      projectScripts(rootDir, file, fileSet, calls);
    } else if (isMakefile(file)) {
      makefileRecipes(rootDir, file, calls);
    }
  }
  return calls;
}

function packageScripts(rootDir: string, file: string, calls: ProcessCall[]): void {
  const source = readText(rootDir, file);
  if (source === undefined) return;
  let doc: unknown;
  try {
    doc = JSON.parse(source);
  } catch {
    return;
  }
  const scripts = (doc as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return;
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command !== 'string') continue;
    calls.push({
      file,
      owner: file,
      callee: `npm script ${name}`,
      argv: splitWords(command),
      span: lineSpan(file, source, `"${name}"`),
      evidence: 'manifest',
      workingDir: dirOf(file),
    });
  }
}

/**
 * `name = "pkg.mod:obj"` runs the module's file. The module is looked up beside the manifest and
 * under `src/`. When neither has it, the command names the expected path and resolves unresolved.
 */
function projectScripts(
  rootDir: string,
  file: string,
  files: ReadonlySet<string>,
  calls: ProcessCall[],
): void {
  const source = readText(rootDir, file);
  if (source === undefined) return;
  let doc: unknown;
  try {
    doc = parseToml(source);
  } catch {
    return;
  }
  const scripts = (doc as { project?: { scripts?: unknown } }).project?.scripts;
  if (typeof scripts !== 'object' || scripts === null) return;
  const dir = dirOf(file);
  for (const [name, target] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof target !== 'string') continue;
    const module = (target.split(/[:[]/)[0] ?? '').trim();
    if (module === '') continue;
    const modulePath = module.replace(/\./g, '/');
    // The package sits in the manifest's own directory, or in its src/ directory. Repository paths.
    const candidates = [dir, path.posix.join(dir, 'src')].flatMap((base) => [
      path.posix.join(base, `${modulePath}.py`),
      path.posix.join(base, `${modulePath}/__init__.py`),
    ]);
    const found =
      candidates.find((candidate) => files.has(candidate)) ??
      path.posix.join(dir, `${modulePath}.py`);
    calls.push({
      file,
      owner: file,
      callee: `[project.scripts] ${name}`,
      // Relative to the manifest's directory, which is where the script runs.
      argv: ['python', path.posix.relative(dir, found)],
      span: tomlKeySpan(file, source, name),
      evidence: 'manifest',
      workingDir: dir,
    });
  }
}

/** The span of the `key = ...` line of a TOML key, or line 1 when no line has that key. */
function tomlKeySpan(file: string, source: string, key: string): SourceSpan {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^\\s*"?${escaped}"?\\s*=`);
  const line = source.split(/\r?\n/).find((candidate) => pattern.test(candidate));
  return lineSpan(file, source, line ?? '');
}

/**
 * Each recipe line under a rule is a command run in the Makefile's directory. A recipe whose
 * program is a variable (`$(PYTHON) scripts/x.py`) is an observation, not a literal command.
 */
function makefileRecipes(rootDir: string, file: string, calls: ProcessCall[]): void {
  const source = readText(rootDir, file);
  if (source === undefined) return;
  const dir = dirOf(file);
  let target = '';
  source.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('\t')) {
      const command = line
        .slice(1)
        .replace(/^[@+-]+/, '')
        .trim();
      if (command === '' || command.startsWith('#')) return;
      const [program = ''] = splitWords(command);
      const span: SourceSpan = {
        filePath: file,
        startLine: index + 1,
        startColumn: 1,
        endLine: index + 1,
        endColumn: line.length + 1,
      };
      calls.push({
        file,
        owner: file,
        callee: `make ${target}`,
        argv: program.includes('$') ? null : splitWords(command),
        span,
        evidence: 'manifest',
        workingDir: dir,
      });
      return;
    }
    const rule = /^([A-Za-z0-9_./%-][^:=#]*?)\s*:(?![=])/.exec(line);
    if (rule !== null) target = (rule[1] ?? '').trim().split(/\s+/)[0] ?? '';
  });
}

function dirOf(file: string): string {
  const dir = posix.dirname(file);
  return dir === '.' ? '' : dir;
}

function readText(rootDir: string, file: string): string | undefined {
  try {
    return fs.readFileSync(path.join(rootDir, file), 'utf8');
  } catch {
    return undefined;
  }
}

/** The span of the first line that contains a needle, or line 1 when none does. */
function lineSpan(file: string, source: string, needle: string): SourceSpan {
  const lines = source.split(/\r?\n/);
  const index = Math.max(
    0,
    lines.findIndex((line) => line.includes(needle)),
  );
  return {
    filePath: file,
    startLine: index + 1,
    startColumn: 1,
    endLine: index + 1,
    endColumn: (lines[index]?.length ?? 0) + 1,
  };
}
