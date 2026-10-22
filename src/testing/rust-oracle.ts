import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { CrateModules, ModuleEdge } from '../analyzer/rust/modules/tree.js';

/**
 * Helpers for the rustc oracle (V3 Phase 8.5). Test-only: they run rustc and evaluate cfg
 * predicates, and neither happens in `generate` or `check`.
 */

// ── cfg predicates (test helper) ────────────────────────────────────────────

export type Predicate =
  | { readonly kind: 'atom'; readonly text: string }
  | { readonly kind: 'all' | 'any'; readonly items: readonly Predicate[] }
  | { readonly kind: 'not'; readonly item: Predicate };

function tokenize(text: string): string[] {
  return text.match(/"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*|[(),=]/g) ?? [];
}

export function parsePredicate(tokens: readonly string[], pos: { i: number }): Predicate {
  const name = tokens[pos.i++];
  if (name === undefined) throw new Error('empty cfg predicate');
  if (tokens[pos.i] === '(') {
    pos.i++;
    const items: Predicate[] = [];
    while (tokens[pos.i] !== ')') {
      if (pos.i >= tokens.length) throw new Error('unclosed cfg predicate');
      items.push(parsePredicate(tokens, pos));
      if (tokens[pos.i] === ',') pos.i++;
    }
    pos.i++;
    const [first] = items;
    if (name === 'all' || name === 'any') return { kind: name, items };
    if (name === 'not' && first !== undefined && items.length === 1) {
      return { kind: 'not', item: first };
    }
    throw new Error(`unknown cfg operator ${name}`);
  }
  if (tokens[pos.i] === '=') {
    pos.i++;
    return { kind: 'atom', text: `${name}=${tokens[pos.i++] ?? ''}` };
  }
  return { kind: 'atom', text: name };
}

/** Parses one `cfg(...)` text, as Balk2 stores it in `metadata.cfg`. */
export function parseCfg(text: string): Predicate {
  const tokens = tokenize(text.slice('cfg'.length));
  if (!text.startsWith('cfg(') || tokens[0] !== '(')
    throw new Error(`not a cfg predicate: ${text}`);
  const pos = { i: 1 };
  const predicate = parsePredicate(tokens, pos);
  if (tokens[pos.i] !== ')' || pos.i !== tokens.length - 1) {
    throw new Error(`trailing tokens in cfg predicate: ${text}`);
  }
  return predicate;
}

export function evaluate(predicate: Predicate, trueSet: ReadonlySet<string>): boolean {
  switch (predicate.kind) {
    case 'atom':
      return trueSet.has(predicate.text);
    case 'all':
      return predicate.items.every((item) => evaluate(item, trueSet));
    case 'any':
      return predicate.items.some((item) => evaluate(item, trueSet));
    case 'not':
      return !evaluate(predicate.item, trueSet);
  }
}

/** Whether a declaration's conditions (joined by ` and `) hold for the given cfg set. */
export function isActive(edge: ModuleEdge, trueSet: ReadonlySet<string>): boolean {
  if (edge.cfg === null) return true;
  return edge.cfg.split(' and ').every((text) => evaluate(parseCfg(text), trueSet));
}

// ── rustc side ──────────────────────────────────────────────────────────────

export function rustcCfgSet(): Set<string> {
  const text = execFileSync('rustc', ['--print', 'cfg'], { encoding: 'utf8' });
  return new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}

/** The `.rs` files rustc reads for one crate root, from its dependency file, sorted. */
export function rustcReads(workspace: string, root: string, outDir: string): string[] {
  const manifest = readFileSync(path.join(workspace, 'Cargo.toml'), 'utf8');
  const edition = /edition\s*=\s*"(\d{4})"/.exec(manifest)?.[1] ?? '2015';
  const crateType = path.basename(root) === 'main.rs' ? 'bin' : 'lib';
  const crateName = `${path.basename(workspace)}_${crateType}`.replace(/-/g, '_');
  const depFile = path.join(outDir, `${crateName}.d`);
  execFileSync(
    'rustc',
    [
      '--edition',
      edition,
      '--crate-type',
      crateType,
      '--crate-name',
      crateName,
      `--emit=dep-info=${depFile}`,
      root,
    ],
    { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // The dependency file is `<output>: <input> <input> ...`, with long lines continued by `\`.
  const text = readFileSync(depFile, 'utf8').replace(/\\\n/g, ' ');
  const inputs = text
    .slice(text.indexOf(':') + 1)
    .trim()
    .split(/\s+/);
  return inputs
    .filter((input) => input.endsWith('.rs') && !path.isAbsolute(input))
    .map((input) => path.posix.normalize(input.split(path.sep).join('/')))
    .sort();
}

/** The files a crate root reaches through declarations whose conditions hold. */
export function reachedWhenActive(crate: CrateModules, trueSet: ReadonlySet<string>): string[] {
  const reached = new Set([crate.root]);
  const queue = [crate.root];
  for (let next = 0; next < queue.length; next++) {
    const file = queue[next];
    if (file === undefined) break;
    for (const edge of crate.edges) {
      if (edge.from === file && isActive(edge, trueSet) && !reached.has(edge.to)) {
        reached.add(edge.to);
        queue.push(edge.to);
      }
    }
  }
  return [...reached].sort();
}
