/**
 * Python mechanisms that the fact-based front end does not produce yet (V3 Phase 5.7a), retired in
 * Phases 11 and 12:
 * - data artifact literals on a line (`addDataLiteralsOnLine`);
 * - the owner of each line, which source annotations read (`ownersByLine`).
 * `importlib.import_module` loads moved to the fact path in Phase 12.5.
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
  place: (value: string) => string = (value) => value,
): void {
  const selfJoins = selfJoinSpans(trimmed, selfDirs);
  // A self-directory join already names a repository path; a bare literal is placed (Phase 11.4).
  const literals = [
    ...selfJoins.map(({ value, index }) => ({ value, index, target: value })),
    ...pathLiteralsInLine(trimmed)
      .filter((lit) => !selfJoins.some((join) => lit.index >= join.index && lit.index < join.end))
      .map((lit) => ({ ...lit, target: place(lit.value) })),
  ];
  for (const { value, index, target } of literals) {
    // A literal the AST catalog has already resolved takes its edge from there (Phase 11.2).
    if (claimed(value)) continue;
    if (isDataPathLiteral(value) && !isNonAccessBefore(trimmed.slice(0, index))) {
      const direction = inferDataDirection(trimmed);
      addDataRelationship(
        filePath,
        target,
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

/**
 * The non-fact mechanisms of one file (V3 Phase 5.7b): data artifact literals on every line.
 * Retired in Phases 11 and 12.
 */
export function addPythonMechanisms(
  filePath: string,
  content: string,
  graph: ConnectionGraph,
  claimed: (line: number, value: string) => boolean = () => false,
  place: (value: string) => string = (value) => value,
): void {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const selfDirs = selfDirectories(lines);

  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    addDataLiteralsOnLine(
      trimmed,
      filePath,
      selfDirs,
      graph,
      (value) => claimed(index + 1, value),
      place,
    );
  }
}
