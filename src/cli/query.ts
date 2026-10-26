import * as fs from 'node:fs';
import { loadBalk2Config } from '../config/balk2-config.js';
import {
  CONFIDENCE_LEVELS,
  DEFAULT_LIMIT,
  DEFAULT_MAX_DEGREE,
  LANGUAGES,
  NODE_KINDS,
  QueryError,
  RELATIONSHIP_FAMILIES,
  queryRelationships,
  type QueryOptions,
  type QueryResult,
} from '../query/map-query.js';
import { deserializeConnectionMap } from '../serialize.js';
import type { Confidence, ConnectionMap } from '../types.js';
import { resolveOutputPaths } from './generate.js';

export interface QueryCommandResult {
  /** 0 on success, 1 when the map is missing or the focus matches nothing, 2 for bad arguments. */
  readonly exitCode: number;
  readonly stdout: readonly string[];
  readonly stderr: readonly string[];
}

export const QUERY_USAGE = `balk2 query [options]

  --focus <file|node>      Limit output to the neighborhood of a file path or node id
  --depth <n>              Hops from the focus to follow (default 1)
  --traverse <list>        Families followed outward from --focus (default code). Other families are
                           listed for each node reached but not expanded further
  --max-degree <n>         Nodes with more relationships are listed but not expanded (default ${DEFAULT_MAX_DEGREE})
  --no-max-degree          Expand every node regardless of how many relationships it has
  --family <list>          Comma-separated: ${RELATIONSHIP_FAMILIES.join(', ')}
  --min-confidence <level> One of: ${CONFIDENCE_LEVELS.join(', ')} (default medium)
  --node-kind <list>       Comma-separated node kinds at both ends: ${NODE_KINDS.join(', ')}
  --language <list>        Comma-separated languages: ${LANGUAGES.join(', ')}. Every endpoint with a
                           known language must be in the list; language-neutral nodes do not exclude
  --limit <n>              Most relationships to print (default ${DEFAULT_LIMIT})
  --no-limit               Print every matching relationship
  --json                   Print JSON instead of text lines
  -o, --output <path>      Where connection-map.json was written (default: connection-map)`;

const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--focus',
  '--depth',
  '--traverse',
  '--max-degree',
  '--family',
  '--min-confidence',
  '--node-kind',
  '--language',
  '--limit',
  '-o',
  '--output',
]);

interface ParsedArgs {
  readonly query: QueryOptions;
  readonly json: boolean;
  readonly output?: string;
}

/**
 * Answer `balk2 query` against the connection map already on disk. Returns the lines to print
 * rather than printing them, so the same logic serves the CLI and tests.
 */
export function runQuery(args: readonly string[], cwd: string = process.cwd()): QueryCommandResult {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    return failure(2, errorMessage(error));
  }

  const { jsonPath } = resolveOutputPaths(cwd, parsed.output ?? loadBalk2Config(cwd)?.output);
  if (!fs.existsSync(jsonPath)) {
    return failure(1, `no connection map at ${jsonPath}; run balk2 generate first`);
  }

  let map: ConnectionMap;
  try {
    map = deserializeConnectionMap(fs.readFileSync(jsonPath, 'utf8'));
  } catch (error) {
    return failure(1, `could not read ${jsonPath}: ${errorMessage(error)}`);
  }

  let result: QueryResult;
  try {
    result = queryRelationships(map, parsed.query);
  } catch (error) {
    if (error instanceof QueryError) return failure(1, error.message);
    throw error;
  }

  const stdout = parsed.json
    ? JSON.stringify(
        {
          focus: result.focus ?? null,
          total: result.total,
          truncated: result.truncated,
          relationships: result.relationships,
        },
        null,
        2,
      ).split('\n')
    : formatText(result, parsed.query.depth ?? 1);
  return { exitCode: 0, stdout, stderr: [] };
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const values = new Map<string, string>();
  let json = false;
  let noLimit = false;
  let noMaxDegree = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--no-limit') {
      noLimit = true;
      continue;
    }
    if (arg === '--no-max-degree') {
      noMaxDegree = true;
      continue;
    }

    const equals = arg.indexOf('=');
    const name = equals >= 0 ? arg.slice(0, equals) : arg;
    if (!VALUE_FLAGS.has(name)) throw new QueryError(`unknown option "${arg}"`);

    const value = equals >= 0 ? arg.slice(equals + 1) : args[++i];
    if (value === undefined || value.startsWith('--') || value.length === 0) {
      throw new QueryError(`${name} needs a value`);
    }
    values.set(name, value);
  }

  const focus = values.get('--focus');
  const depthText = values.get('--depth');
  const family = values.get('--family');
  const confidence = values.get('--min-confidence');
  const nodeKind = values.get('--node-kind');
  const language = values.get('--language');
  const limitText = values.get('--limit');
  const traverse = values.get('--traverse');
  const maxDegreeText = values.get('--max-degree');
  const output = values.get('-o') ?? values.get('--output');

  if (noLimit && limitText !== undefined) {
    throw new QueryError('--limit and --no-limit cannot be used together');
  }

  if (noMaxDegree && maxDegreeText !== undefined) {
    throw new QueryError('--max-degree and --no-max-degree cannot be used together');
  }
  let maxDegree: number | undefined;
  if (noMaxDegree) {
    maxDegree = Infinity;
  } else if (maxDegreeText !== undefined) {
    if (!/^\d+$/.test(maxDegreeText) || Number(maxDegreeText) < 1) {
      throw new QueryError('--max-degree must be a whole number of at least 1');
    }
    maxDegree = Number(maxDegreeText);
  }

  let depth: number | undefined;
  if (depthText !== undefined) {
    if (!/^\d+$/.test(depthText)) throw new QueryError('--depth must be a whole number');
    depth = Number(depthText);
  }

  let limit: number | undefined;
  if (noLimit) {
    limit = Infinity;
  } else if (limitText !== undefined) {
    if (!/^\d+$/.test(limitText) || Number(limitText) < 1) {
      throw new QueryError('--limit must be a whole number of at least 1');
    }
    limit = Number(limitText);
  }

  let minConfidence: Confidence | undefined;
  if (confidence !== undefined) {
    if (!(CONFIDENCE_LEVELS as readonly string[]).includes(confidence)) {
      throw new QueryError(`--min-confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}`);
    }
    minConfidence = confidence as Confidence;
  }

  const query: QueryOptions = {
    ...(focus !== undefined ? { focus } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(traverse !== undefined
      ? { traverse: parseList(traverse, RELATIONSHIP_FAMILIES, '--traverse') }
      : {}),
    ...(maxDegree !== undefined ? { maxDegree } : {}),
    ...(family !== undefined
      ? { families: parseList(family, RELATIONSHIP_FAMILIES, '--family') }
      : {}),
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    ...(nodeKind !== undefined
      ? { nodeKinds: parseList(nodeKind, NODE_KINDS, '--node-kind') }
      : {}),
    ...(language !== undefined ? { languages: parseList(language, LANGUAGES, '--language') } : {}),
  };

  return { query, json, ...(output !== undefined ? { output } : {}) };
}

function parseList<T extends string>(raw: string, allowed: readonly T[], flag: string): T[] {
  const items = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) throw new QueryError(`${flag} needs at least one value`);

  for (const item of items) {
    if (!(allowed as readonly string[]).includes(item)) {
      throw new QueryError(`${flag}: unknown value "${item}" (expected ${allowed.join(', ')})`);
    }
  }
  return items as T[];
}

function formatText(result: QueryResult, depth: number): string[] {
  const lines: string[] = [];
  if (result.focus !== undefined) lines.push(`focus: ${result.focus} (depth ${depth})`);
  if (result.relationships.length === 0) lines.push('no relationships match');
  for (const rel of result.relationships) {
    lines.push(`${rel.from} --${rel.type}--> ${rel.to} [${rel.confidence}]`);
  }
  if (result.truncated) {
    lines.push(
      `showing ${result.relationships.length} of ${result.total} relationships; ` +
        'use --limit <n> or --no-limit to see more',
    );
  }
  return lines;
}

function failure(exitCode: number, message: string): QueryCommandResult {
  return { exitCode, stdout: [], stderr: [`balk2 query: ${message}`] };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
