import * as fs from 'fs';
import * as path from 'path';
import { deserializeConnectionMap, serializeConnectionMap } from '../serialize.js';
import { loadBalk2Config } from '../config/index.js';
import { buildConnectionGraph } from './build-graph.js';

export interface CheckOptions {
  readonly cwd?: string;
  readonly output?: string;
}

export interface CheckResult {
  readonly isCurrent: boolean;
  readonly message: string;
}

/**
 * Validate configuration and check whether the generated connection map is current.
 */
export function checkConnectionMap(options: CheckOptions = {}): CheckResult {
  const rootDir = path.resolve(options.cwd ?? process.cwd());
  const balk2Config = loadBalk2Config(rootDir);
  const jsonPath = path.join(rootDir, 'connection-map.json');

  if (!fs.existsSync(jsonPath)) {
    return {
      isCurrent: false,
      message: 'connection-map.json does not exist. Run "balk2" to generate.',
    };
  }

  try {
    const existingContent = fs.readFileSync(jsonPath, 'utf8');
    const existingMap = deserializeConnectionMap(existingContent);

    // Build fresh graph through the same path as `generate`
    const graph = buildConnectionGraph(rootDir, balk2Config);

    const freshMap = graph.build({
      commit: existingMap.repository.commit,
      generatedAt: existingMap.repository.generatedAt,
    });

    const freshJson = serializeConnectionMap(freshMap);

    if (existingContent.trim() === freshJson.trim()) {
      return {
        isCurrent: true,
        message: 'connection-map.json is current with repository state.',
      };
    } else {
      return {
        isCurrent: false,
        message: 'connection-map.json is out of date. Run "balk2" to regenerate.',
      };
    }
  } catch (err) {
    return {
      isCurrent: false,
      message: `Failed to read or parse existing connection map: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
