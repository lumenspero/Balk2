import { describe, expect, it } from 'vitest';
import * as api from './index.js';
import type {
  StateAccess,
  StateConfig,
  StateCoupling,
  StatePathNode,
  StateProtocol,
  StateRelationship,
} from './index.js';

describe('public API: shared state', () => {
  it('exports the state queries from the package root', () => {
    expect(typeof api.getStateReaders).toBe('function');
    expect(typeof api.getStateWriters).toBe('function');
    expect(typeof api.getStateCoupling).toBe('function');
  });

  it('exports the state configuration and protocol types for consumers', () => {
    // Type-only exports are checked by the compiler; these lines fail `tsc` if one goes missing.
    const config: StateConfig = {
      singletons: [{ module: 'src/store.ts', export: 'store' }],
      dynamicPaths: 'wildcard',
    };
    const access: StateAccess = 'update';
    const protocol: StateProtocol = { method: 'patch', access, keyArg: 0 };
    const relationship: StateRelationship = 'readsState';
    const coupling: StateCoupling[] = [];
    const node: StatePathNode | undefined = undefined;

    expect([config, protocol, relationship, coupling, node]).toHaveLength(5);
  });
});
