import { describe, expect, it } from 'vitest';
import { registryKeyId } from '../graph.js';
import { runRegistryEngine } from './registry-engine.js';
import type {
  RegistryCallFact,
  RegistryConfiguredKey,
  RegistryDeclarationFact,
  RegistryInjectionFact,
} from './types.js';

const span = { filePath: 'src/a.ts', startLine: 3, startColumn: 1, endLine: 3, endColumn: 20 };
const scope = 'src/c.ts:container';

function lookup(overrides: Partial<RegistryCallFact> = {}): RegistryCallFact {
  return {
    kind: 'registry-call',
    filePath: 'src/a.ts',
    span,
    owner: 'src/a.ts:run',
    subject: 'container.get("user")',
    assignment: false,
    relationship: 'resolves',
    protocolSource: 'built-in',
    configuredReceiver: false,
    receiver: {
      identity: { kind: 'resolved', scope, confidence: 'high' },
      qualifies: true,
      qualificationEvidence: 'ts-program',
      internal: false,
    },
    key: {
      kind: 'static',
      name: 'user',
      keyType: 'string',
      numericLiteral: false,
      evidence: 'ast',
    },
    ...overrides,
  };
}

function run(
  facts: RegistryCallFact[] = [],
  configured: RegistryConfiguredKey[] = [],
  extra: Array<RegistryDeclarationFact | RegistryInjectionFact> = [],
): ReturnType<typeof runRegistryEngine> {
  return runRegistryEngine({ configured, facts: [...extra, ...facts] });
}

describe('runRegistryEngine', () => {
  it('declares a configured key, with its target when the target is in the graph', () => {
    expect(run([], [{ registry: scope, key: 'user', target: 'src/u.ts:User' }])).toEqual([
      {
        kind: 'declare',
        registry: scope,
        key: 'user',
        keyType: 'string',
        target: 'src/u.ts:User',
        confidence: 'high',
        evidence: 'config',
      },
    ]);
  });

  it('links a lookup of a declared key to the key, with the qualification evidence', () => {
    const edges = run([lookup()], [{ registry: scope, key: 'user' }]);
    expect(edges.slice(1)).toEqual([
      {
        kind: 'use',
        registry: scope,
        key: 'user',
        keyType: 'string',
        relationship: 'resolves',
        from: 'src/a.ts:run',
        confidence: 'high',
        evidence: 'ts-program',
        span,
      },
    ]);
  });

  it('reports a lookup that names a key another registry declares, when its own registry declares others', () => {
    const edges = run(
      [lookup()],
      [
        { registry: 'src/other.ts:other', key: 'user' },
        { registry: scope, key: 'role' },
      ],
    );
    expect(edges[edges.length - 1]).toEqual({
      kind: 'ambiguous',
      relationship: 'resolves',
      from: 'src/a.ts:run',
      subject: 'container.get("user")',
      span,
      candidates: [registryKeyId('user', 'src/other.ts:other', 'string')],
      detail: '"user" is not declared in this registry, but 1 other registry declares it',
    });
  });

  it('leaves a lookup into a registry nobody declares alone', () => {
    const edges = run([lookup()], [{ registry: 'src/other.ts:other', key: 'user' }]);
    expect(edges.map((edge) => edge.kind)).toEqual(['declare', 'use']);
  });

  it('observes a dynamic key on a trusted receiver, internal when its storage is private', () => {
    const dynamic = lookup({
      configuredReceiver: true,
      key: { kind: 'dynamic', reason: 'key is a parameter' },
      receiver: {
        identity: { kind: 'resolved', scope, confidence: 'high' },
        qualifies: true,
        qualificationEvidence: 'ts-program',
        internal: true,
      },
    });
    expect(run([dynamic])).toEqual([
      {
        kind: 'observe',
        relationship: 'resolves',
        from: 'src/a.ts:run',
        reason: 'dynamic-registry-key',
        subject: 'container.get("user")',
        detail: 'key is a parameter',
        span,
        tier: 'internal',
      },
    ]);
  });

  it('forms no observation for a dynamic key on an untrusted receiver', () => {
    const dynamic = lookup({ key: { kind: 'dynamic', reason: 'key is a parameter' } });
    expect(run([dynamic])).toEqual([]);
  });

  it('observes an unknown receiver identity only when the receiver is trusted', () => {
    const unknown = (configuredReceiver: boolean): RegistryCallFact =>
      lookup({
        configuredReceiver,
        receiver: {
          identity: { kind: 'unknown', reason: 'receiver type is any' },
          qualifies: true,
          qualificationEvidence: 'ts-program',
          internal: false,
        },
      });
    expect(run([unknown(true)])).toEqual([
      expect.objectContaining({
        kind: 'observe',
        reason: 'unknown-registry-receiver',
        detail: 'receiver type is any',
      }),
    ]);
    expect(run([unknown(false)])).toEqual([]);
  });

  it('skips a receiver that does not qualify, and an argument that cannot be a key', () => {
    const unqualified = lookup({
      receiver: {
        identity: { kind: 'resolved', scope, confidence: 'high' },
        qualifies: false,
        qualificationEvidence: 'ts-program',
        internal: false,
      },
    });
    expect(run([unqualified])).toEqual([]);
    expect(run([lookup({ key: { kind: 'not-a-name' } })])).toEqual([]);
  });

  it('skips an assignment without a known value, and registers an assignment with one', () => {
    const bare = lookup({
      assignment: true,
      relationship: 'registers',
      key: {
        kind: 'static',
        name: '404',
        keyType: 'string',
        numericLiteral: true,
        evidence: 'ast',
      },
    });
    expect(run([bare])).toEqual([]);

    const valued = lookup({
      assignment: true,
      relationship: 'registers',
      target: 'src/u.ts:NotFound',
      subject: 'handlers[404] = NotFound',
      key: {
        kind: 'static',
        name: '404',
        keyType: 'string',
        numericLiteral: true,
        evidence: 'ast',
      },
    });
    expect(run([valued])).toEqual([
      {
        kind: 'use',
        registry: scope,
        key: '404',
        keyType: 'string',
        relationship: 'registers',
        from: 'src/a.ts:run',
        target: 'src/u.ts:NotFound',
        confidence: 'high',
        evidence: 'ast',
        span,
      },
    ]);
  });

  it('takes config evidence for a configured protocol', () => {
    expect(run([lookup({ protocolSource: 'config' })])).toEqual([
      expect.objectContaining({ kind: 'use', evidence: 'config' }),
    ]);
  });

  it('records a decorator with a dynamic key as an observation from the decorated symbol', () => {
    const decorator: RegistryDeclarationFact = {
      kind: 'registry-declaration',
      filePath: 'src/u.ts',
      span,
      source: 'decorator',
      subject: 'register(name)',
      registry: scope,
      key: { kind: 'dynamic', reason: 'key is a variable' },
      target: 'src/u.ts:User',
      targetInGraph: true,
      confidence: 'high',
      evidence: 'config',
    };
    expect(run([], [], [decorator])).toEqual([
      {
        kind: 'observe',
        relationship: 'registers',
        from: 'src/u.ts:User',
        reason: 'dynamic-registry-key',
        subject: 'register(name)',
        detail: 'key is a variable',
        span,
      },
    ]);
  });

  it('declares a decorator key without a target when the target is not in the graph', () => {
    const decorator: RegistryDeclarationFact = {
      kind: 'registry-declaration',
      filePath: 'src/u.ts',
      span,
      source: 'decorator',
      subject: 'register("user")',
      registry: scope,
      key: {
        kind: 'static',
        name: 'user',
        keyType: 'string',
        numericLiteral: false,
        evidence: 'ast',
      },
      target: 'src/u.ts:User',
      targetInGraph: false,
      confidence: 'high',
      evidence: 'config',
    };
    expect(run([], [], [decorator])).toEqual([
      {
        kind: 'declare',
        registry: scope,
        key: 'user',
        keyType: 'string',
        confidence: 'high',
        evidence: 'config',
      },
    ]);
  });

  it('links a static injection to its key, and observes a dynamic one', () => {
    const injected: RegistryInjectionFact = {
      kind: 'registry-injection',
      filePath: 'src/s.ts',
      span,
      owner: 'src/s.ts:Service',
      registry: scope,
      key: {
        kind: 'static',
        name: 'UserRepo',
        keyType: 'type',
        numericLiteral: false,
        evidence: 'ts-program',
      },
      subject: '@Inject(UserRepo)',
    };
    expect(run([], [], [injected])).toEqual([
      {
        kind: 'inject',
        owner: 'src/s.ts:Service',
        registry: scope,
        key: 'UserRepo',
        keyType: 'type',
        span,
      },
    ]);

    const dynamic: RegistryInjectionFact = {
      ...injected,
      key: { kind: 'dynamic', reason: 'type argument is not a class' },
    };
    expect(run([], [], [dynamic])).toEqual([
      {
        kind: 'observe',
        relationship: 'resolves',
        from: 'src/s.ts:Service',
        reason: 'dynamic-registry-key',
        subject: '@Inject(UserRepo)',
        detail: 'type argument is not a class',
        span,
      },
    ]);
  });
});
