import type { ConnectionGraph } from '../graph.js';
import type { ModuleLoad } from './module-loads.js';

/**
 * Record each dynamic module load whose specifier is not a constant as a `dynamic-module-specifier`
 * observation.
 *
 * The observation is an unresolved-reference node at the load's location. The owning symbol or file
 * links to it with a `low`-confidence `imports` relationship, the type the load would have created
 * had its target been known. No edge names a target, so the graph never guesses which file the load
 * reaches. The load's `loadKind` is kept in the link's metadata, so the reader can see how it loads.
 *
 * Only `dynamic` loads are recorded here. Constant loads that name no repository file are not yet
 * reported, because there is no unresolved reason for them; that decision belongs to 7.1.6.
 */
export function recordDynamicLoads(loads: readonly ModuleLoad[], graph: ConnectionGraph): void {
  for (const load of loads) {
    if (load.status !== 'dynamic') continue;

    const unresolved = graph.addUnresolved({
      reason: 'dynamic-module-specifier',
      attempted: 'imports',
      subject: load.subject,
      location: load.span,
      detail: load.reason,
    });

    graph.addRelationship('imports', load.owner, unresolved.id, 'low', {
      evidence: 'ts-program',
      spans: [load.span],
      metadata: { loadKind: load.loadKind },
    });
  }
}
