import type { ConnectionGraph } from '../graph.js';
import { applyModuleLoads } from './module-load-apply.js';
import type { ModuleLoad } from './module-loads.js';

/**
 * Record each dynamic module load whose specifier is not a constant as a `dynamic-module-specifier`
 * observation. The work is done by the module-load engine (`applyModuleLoads`); this keeps the
 * earlier entry point for callers that pass only dynamic loads.
 */
export function recordDynamicLoads(loads: readonly ModuleLoad[], graph: ConnectionGraph): void {
  applyModuleLoads(
    loads.filter((load) => load.status === 'dynamic'),
    graph,
  );
}
