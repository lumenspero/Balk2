import type { FactLanguage, FileFacts, ModuleEdge } from '../facts/types.js';
import type { ModuleLoad } from './module-loads.js';

/**
 * The TypeScript front end for module loads. The front end has already recognized each load and
 * resolved its specifier (`module-loads.ts`). This turns each one into a `load` module-edge fact,
 * grouped by file in the order the loads were found.
 */
export function moduleLoadFacts(loads: readonly ModuleLoad[]): FileFacts[] {
  const byFile = new Map<string, ModuleEdge[]>();
  for (const load of loads) {
    const facts = byFile.get(load.filePath) ?? [];
    facts.push(loadFact(load));
    byFile.set(load.filePath, facts);
  }
  return [...byFile].map(([filePath, facts]) => ({
    filePath,
    language: languageOf(filePath),
    facts,
  }));
}

function loadFact(load: ModuleLoad): ModuleEdge {
  const base = {
    kind: 'module-edge' as const,
    filePath: load.filePath,
    span: load.span,
    owner: load.owner,
    form: 'load' as const,
    names: [],
    typeOnly: false,
    loadKind: load.loadKind,
  };
  switch (load.status) {
    case 'internal':
      return { ...base, specifier: load.specifier, target: { kind: 'file', path: load.target } };
    case 'external':
      return {
        ...base,
        specifier: load.specifier,
        target: { kind: 'external', name: load.specifier },
      };
    case 'unresolved':
      return {
        ...base,
        specifier: load.specifier,
        target: { kind: 'unresolved', reason: 'unresolved-module-path', subject: load.specifier },
      };
    case 'dynamic':
      // The specifier is not a constant, so there is none to record. The subject is the load's text.
      return {
        ...base,
        specifier: '',
        target: { kind: 'unresolved', reason: 'dynamic-module-specifier', subject: load.subject },
      };
  }
}

function languageOf(filePath: string): FactLanguage {
  return /\.(ts|tsx|mts|cts)$/.test(filePath) ? 'typescript' : 'javascript';
}
