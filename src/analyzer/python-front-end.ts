import { appliesTo, PYTHON_LANGUAGES, scopeRegistries } from '../config/protocol-scope.js';
import { pathBaseOrder } from '../config/path-base-config.js';
import type { StateSingleton } from '../config/state-config.js';
import type { PathBase } from '../facts/path-value.js';
/**
 * The Python front end (V3 Phase 5.7b and 5.7c). It runs the fact passes over a set of Python files
 * and writes their graph entries: files, symbols, exports, imports, `extends`, `implements`,
 * `calls`, `references` and event channels. Every fact-derived edge carries `evidence: 'ast'` and its spans.
 *
 * The non-fact mechanisms still run through python-mechanisms.ts (data literals, importlib loads)
 * and python-source-apply.ts (source annotations). Phases 11 and 12 retire them.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ConnectionGraph } from '../graph.js';
import { normalizePath } from '../graph.js';
import type {
  FrontEndInput,
  FrontEndLanguage,
  FrontEndResult,
  LanguageFrontEnd,
} from './front-end.js';
import { addPythonMechanisms } from './python-mechanisms.js';
import { applyDataEdges } from '../data/data-analyzer.js';
import { runDataEngine } from '../facts/data-engine.js';
import { defaultBareBases, resolveBarePath } from '../facts/path-value.js';
import { analyzePythonDataApis } from './python/data-apis.js';
import { collectPythonSourceAnnotations } from './python-source-apply.js';
import { analyzePythonCalls, combineObservers } from './python/calls.js';
import { createPythonRegistryCollector } from './python/registry-facts.js';
import { createPythonStateCollector, type ModuleBinding } from './python/state-facts.js';
import {
  createPythonCallbackCollector,
  PYTHON_CALLBACK_CATALOG,
  pythonCallbackFiles,
} from './python/callback-facts.js';
import { applyCallbackEdges } from './callback-apply.js';
import { applyModuleLoadEdges } from './module-load-apply.js';
import { runModuleLoadEngine } from '../facts/module-load-engine.js';
import { createPythonLoadCollector, pythonLoadFiles } from './python/load-facts.js';
import { createPythonResourceCollector, pythonResourceFiles } from './python/resource-facts.js';
import { runResourceEngine } from '../facts/resource-engine.js';
import { applyResourceEdges } from './resource-edges.js';
import type { ResourceProtocol } from './resource-protocols.js';
import { runCallbackEngine } from '../facts/callback-engine.js';
import { applyStateEdges } from './state-apply.js';
import { runStateEngine, statePathFiles } from '../facts/state-engine.js';
import { applyRegistryEdges } from './registry-apply.js';
import type {
  RegistryAttributeRule,
  RegistryNameInjectionRule,
  RegistryProtocol,
} from './registry-protocols.js';
import { runRegistryEngine } from '../facts/registry-engine.js';
import { createPythonEventCollector } from './python/event-facts.js';
import { runEventEngine } from '../facts/event-engine.js';
import { applyEventEdges } from './event-apply.js';
import { parseModuleRecovering } from './python/statement-parser.js';
import { createImportResolver } from './python/modules/import-resolution.js';
import { ModuleIndex } from './python/modules/module-index.js';
import { createSymbolResolver } from './python/modules/module-exports.js';
import { pythonPyo3Bindings } from './python/pyo3-bindings.js';
import { pythonProcesses } from './process/python-processes.js';
import { analyzeInheritance, toSourceSpan, type InheritanceFile } from './python/inheritance.js';
import { analyzePythonReferences } from './python/references.js';
import { analyzePythonSymbols } from './python/symbols.js';
import type { SyntaxErrorNote } from './repository-program.js';
import type { PackageNode } from '../types.js';
import { resolveEntryPoints } from './python/modules/entry-points.js';
import type {
  ManifestProblem,
  PythonEntryPointDeclaration,
} from './python/project/python-packages.js';

function isPythonPath(filePath: string): boolean {
  return normalizePath(filePath).toLowerCase().endsWith('.py');
}

/**
 * Writes the graph entries of a set of Python files (V3 Phase 5.7c). `sources` are the files to
 * analyze. `knownFiles` are every repository file, which module resolution searches. `readText`
 * returns the text of any Python file, so an import can be resolved against its exports.
 */
/** Options for one pass over Python sources. */
export interface PythonSourceOptions {
  /** The base order from `data.pathBase` for Python (Phase 11.4), when configured. */
  readonly pathBase?: readonly PathBase[];
  /** Import roots, repository-relative, in precedence order. Defaults to the repository root. */
  readonly roots?: readonly string[];
  /** Decorators that return their argument unchanged, from `python.identityDecorators`. */
  readonly identityDecorators?: readonly string[];
  /** Fixture-style parameter injection from `protocols.registries.nameInjection`. */
  readonly nameInjection?: readonly RegistryNameInjectionRule[];
  /** Attributes and decorators that register the item they sit on, from `protocols.registries`. */
  readonly attributes?: readonly RegistryAttributeRule[];
  /** Methods with a configured registry, from `protocols.registries.methods`. */
  readonly methods?: readonly RegistryProtocol[];
  /** Configured loader functions that read a resource path, from `protocols.resources` (Phase 12.6). */
  readonly resources?: readonly ResourceProtocol[];
  /** Module exports that hold shared state, from `state.singletons` (Phase 12.3) */
  readonly singletons?: readonly StateSingleton[];
  /** Package facts whose entry points resolve here, where the module index exists (V3 Phase 4.5) */
  readonly entryPoints?: {
    readonly packages: readonly PackageNode[];
    readonly declarations: readonly PythonEntryPointDeclaration[];
  };
}

export function analyzePythonSources(
  sources: readonly InheritanceFile[],
  knownFiles: ReadonlySet<string>,
  readText: (filePath: string) => string,
  graph: ConnectionGraph,
  options: PythonSourceOptions = {},
): ManifestProblem[] {
  const modules = [...new Set([...knownFiles, ...sources.map((s) => s.filePath)])].filter(
    isPythonPath,
  );
  const index = new ModuleIndex(modules);
  const roots = options.roots?.length ? options.roots : ['.'];
  const imports = createImportResolver(index, { roots, readText });
  const symbols = createSymbolResolver({ resolver: imports, readText });
  const ctx = { symbols, imports };

  for (const { filePath } of sources) graph.addFile(filePath, 'python');

  // Imports: a repository file is an edge, with the statement's span as evidence. The names each
  // file binds to a module are kept for the state pass (Phase 12.3).
  const moduleBindings = new Map<string, Map<string, ModuleBinding>>();
  const singletonRoots = new Set(
    (options.singletons ?? []).map((singleton) => `${singleton.module}:${singleton.export}`),
  );
  for (const { filePath, source } of sources) {
    const bound = new Map<string, ModuleBinding>();
    for (const r of imports.resolveFile(filePath, source)) {
      if (r.target.kind === 'file') {
        graph.addRelationship('imports', filePath, r.target.path, 'high', {
          evidence: 'ast',
          spans: [toSourceSpan(r.span, filePath)],
        });
      }
      // `from threading import Thread` binds a member of an external module, by its qualified name.
      if (r.form === 'from' && r.via === 'unresolved' && r.target.kind === 'external') {
        r.names.forEach((local, i) => {
          const member = r.imported?.[i];
          if (member !== undefined)
            bound.set(local, { kind: 'member', name: `${r.specifier}.${member}` });
        });
        continue;
      }
      // `from store import store` binds a configured singleton, found by its module and export.
      if (r.form === 'from' && r.via === 'attribute' && r.target.kind === 'file') {
        const module = r.target.path;
        r.names.forEach((local, i) => {
          const root = `${module}:${r.imported?.[i] ?? local}`;
          if (singletonRoots.has(root)) bound.set(local, { kind: 'singleton', root });
        });
        continue;
      }
      // Only `import mod` and `import mod as name` bind a module. `import pkg.mod` binds `pkg`, and
      // `from pkg import name` binds a member, so neither is kept.
      const name = r.names[0];
      if (name === undefined || r.names.length !== 1) continue;
      // `from pkg import store` binds the submodule `store`, which is a module, not a member.
      if (r.form === 'from' && r.via === 'submodule' && r.target.kind === 'file') {
        bound.set(name, { kind: 'file', path: r.target.path });
        continue;
      }
      if (r.form !== 'import') continue;
      // `import pkg.mod` binds the root package `pkg` when it is external, so `pkg.mod.f()` can be read
      // (Phase 12.5). A repository package and an aliased import bind nothing here.
      if (r.specifier.includes('.')) {
        const root = r.specifier.split('.')[0] ?? '';
        if (name === root && r.target.kind === 'external') {
          bound.set(root, { kind: 'external', name: root });
        }
        continue;
      }
      if (r.target.kind === 'file') bound.set(name, { kind: 'file', path: r.target.path });
      else if (r.target.kind === 'external') {
        bound.set(name, { kind: 'external', name: r.target.name });
      }
    }
    moduleBindings.set(filePath, bound);
  }

  // Symbols and exports. A symbol's id is `file:qualified.name`, which `addSymbol` builds from
  // the name, so the qualified name is taken from the declaration id.
  for (const { filePath, source } of sources) {
    for (const d of analyzePythonSymbols(source, filePath).declarations) {
      graph.addSymbol(filePath, d.id.slice(filePath.length + 1), d.symbolType);
      if (d.exported) graph.addRelationship('exports', filePath, d.id);
    }
  }

  // Inheritance: `extends` to repository classes, and `implements` from `ABC.register`.
  const inheritance = analyzeInheritance(sources, ctx);
  for (const c of inheritance.classes) {
    for (const base of c.bases) {
      if (base.target?.kind !== 'symbol') continue;
      graph.addRelationship('extends', c.id, base.target.id, 'high', {
        evidence: 'ast',
        spans: [base.span],
      });
    }
  }
  for (const im of inheritance.implementations) {
    graph.addRelationship('implements', im.classId, im.abcId, 'high', {
      evidence: 'ast',
      spans: [im.span],
    });
  }

  // Events (Phase 12.1). The collector reads the calls the call pass types, as event-call facts.
  const events = createPythonEventCollector(sources, ctx);

  // Registries (Phase 12.2). Dictionary stores, loads and literal displays, read by the same walk.
  const registries = createPythonRegistryCollector({
    nameInjection: options.nameInjection,
    attributes: options.attributes,
    methods: options.methods,
  });

  // Shared state (Phase 12.3). Module globals that functions write through `global`.
  const state = createPythonStateCollector({ bindings: moduleBindings });
  // Callbacks passed to library calls (Phase 12.4), such as `threading.Thread(target=f)`.
  const callbacks = createPythonCallbackCollector({ bindings: moduleBindings });
  // Dynamic module loads (Phase 12.5): `importlib.import_module(name)`.
  const loads = createPythonLoadCollector({
    bindings: moduleBindings,
    index,
    roots,
    files: knownFiles,
  });
  // Resource reads (Phase 12.6): importlib.resources, pkgutil.get_data and configured loader calls.
  const resources = createPythonResourceCollector({
    bindings: moduleBindings,
    index,
    roots,
    files: knownFiles,
    loaders: options.resources ?? [],
  });

  // Calls. The owner is the enclosing function or method, or the file for module-level code.
  for (const c of analyzePythonCalls(
    sources,
    ctx,
    { identityDecorators: options.identityDecorators },
    combineObservers(
      events.observer,
      registries.observer,
      state.observer,
      callbacks.observer,
      loads.observer,
      resources.observer,
    ),
  ).calls) {
    if (c.callee.kind !== 'symbol') continue;
    graph.addRelationship('calls', c.owner ?? c.filePath, c.callee.id, c.confidence, {
      evidence: 'ast',
      spans: [c.span],
      ...(c.mechanism === undefined ? {} : { metadata: { mechanism: c.mechanism } }),
    });
  }

  applyEventEdges(graph, runEventEngine({ facts: events.facts() }));
  applyStateEdges(
    graph,
    runStateEngine({
      files: statePathFiles(state.facts(), 'python'),
      dynamicPaths: 'off',
    }),
  );
  applyCallbackEdges(
    graph,
    runCallbackEngine({
      files: pythonCallbackFiles(callbacks.facts()),
      catalog: PYTHON_CALLBACK_CATALOG,
    }),
  );
  applyModuleLoadEdges(runModuleLoadEngine(pythonLoadFiles(loads.facts())), graph);
  applyResourceEdges(graph, [
    ...runResourceEngine({
      files: pythonResourceFiles(resources.callFacts()),
      catalog: (options.resources ?? []).map((protocol) => ({
        function: protocol.function,
        specifierArg: protocol.specifierArg,
        languages: ['python' as const],
      })),
      fileExists: (repoPath) => knownFiles.has(repoPath),
    }),
    ...resources.edges(),
  ]);
  applyRegistryEdges(graph, runRegistryEngine({ configured: [], facts: registries.facts() }));

  // References: annotations, bases, isinstance targets, except classes and match classes.
  for (const r of analyzePythonReferences(sources, ctx).references) {
    if (r.target.kind !== 'symbol') continue;
    graph.addRelationship('references', r.owner ?? r.filePath, r.target.id, r.confidence, {
      evidence: 'ast',
      spans: [r.span],
    });
  }

  // Data lineage (Phase 11.2): catalog calls whose artifact is a literal. A bare path is placed
  // from the script's directory, then the repository root (11.4).
  const dataFacts = analyzePythonDataApis(sources, ctx);
  applyDataEdges(
    graph,
    runDataEngine({
      facts: dataFacts,
      paths: {
        exists: (repoPath) => knownFiles.has(repoPath),
        bases: (fact) =>
          defaultBareBases(
            'python',
            { file: dirOf(fact.pathFilePath ?? fact.filePath) },
            options.pathBase,
          ),
      },
    }),
  );
  // An anchored path claims the literal it was built from, which is the last path segment (Phase 11.2).
  const claimed = new Set(
    dataFacts.map(
      (f) =>
        `${f.filePath}:${f.span.startLine}:${f.anchored === true ? lastSegment(f.path) : f.path}`,
    ),
  );

  // Entry points: script roots, `packageRoot` edges, and `registers` edges for plugin groups.
  const manifestProblems: ManifestProblem[] = [];
  if (options.entryPoints !== undefined) {
    const resolution = resolveEntryPoints({
      packages: options.entryPoints.packages,
      declarations: options.entryPoints.declarations,
      index,
      roots,
      symbols,
    });
    for (const node of resolution.packages) graph.addPackage(node);
    for (const root of resolution.packageRoots) {
      graph.addRelationship('packageRoot', root.packageId, root.file, 'high', {
        evidence: 'manifest',
      });
    }
    for (const registration of resolution.registrations) {
      const target = registration.target;
      if (target.kind !== 'symbol' && target.kind !== 'file') continue;
      const key = graph.addRegistryKey(registration.registryKey, '.');
      graph.addRelationship(
        'registers',
        key.id,
        target.kind === 'symbol' ? target.id : target.path,
        'high',
        { evidence: 'manifest' },
      );
    }
    manifestProblems.push(...resolution.problems);
  }

  // Non-fact mechanisms, until Phases 11 and 12.
  for (const { filePath, source } of sources) {
    // A bare literal on a line with no catalog call is placed by the same 11.4 rule (Phase 11.6).
    const bases = defaultBareBases('python', { file: dirOf(filePath) }, options.pathBase);
    const place = (value: string): string =>
      resolveBarePath(value, bases, (repoPath) => knownFiles.has(repoPath)) ?? value;
    addPythonMechanisms(
      filePath,
      source,
      graph,
      (line, value) => claimed.has(`${filePath}:${line}:${value}`),
      place,
    );
  }
  return manifestProblems;
}

export class PythonFrontEnd implements LanguageFrontEnd {
  readonly name = 'PythonFrontEnd';
  readonly languages: readonly FrontEndLanguage[] = ['python'];

  canHandle(filePath: string): boolean {
    return isPythonPath(filePath);
  }

  analyze(input: FrontEndInput, graph: ConnectionGraph): FrontEndResult {
    const sourceTexts: Record<string, string> = {};
    const files: InheritanceFile[] = [];
    const syntaxErrors: SyntaxErrorNote[] = [];
    for (const relFile of input.files) {
      const filePath = normalizePath(relFile);
      if (!this.canHandle(filePath)) continue;
      try {
        const source = fs.readFileSync(path.join(input.rootDir, relFile), 'utf8');
        sourceTexts[filePath] = source;
        files.push({ filePath, source });
        // The parser recovers past each error, so every file is still analyzed (3.3).
        for (const e of parseModuleRecovering(source).errors) {
          syntaxErrors.push({ path: filePath, line: e.line, column: e.column, message: e.message });
        }
      } catch {
        // Skip unreadable files, as the former per-file loop did.
      }
    }

    const pyRegistries = scopeRegistries(input.config?.protocols?.registries, PYTHON_LANGUAGES);
    const manifestProblems = analyzePythonSources(
      files,
      new Set(input.files.map(normalizePath)),
      (p) => sourceTexts[p] ?? '',
      graph,
      {
        roots: input.config?.python?.roots,
        pathBase: pathBaseOrder(input.config, 'python'),
        identityDecorators: input.config?.python?.identityDecorators,
        nameInjection: pyRegistries?.nameInjection,
        attributes: pyRegistries?.attributes,
        methods: pyRegistries?.methods,
        singletons: input.config?.state?.singletons,
        resources: appliesTo(input.config?.protocols?.resources, PYTHON_LANGUAGES),
        entryPoints: input.packages
          ? {
              packages: input.packages.python.packages,
              declarations: input.packages.python.entryPoints,
            }
          : undefined,
      },
    );

    return {
      problems: [],
      syntaxErrors,
      sourceAnnotations: collectPythonSourceAnnotations(sourceTexts, []),
      manifestProblems,
      bindings: pythonPyo3Bindings(files),
      processes: pythonProcesses(files),
    };
  }
}

/** The directory of a repository path, or '' for a file at the root. */
function dirOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash < 0 ? '' : filePath.slice(0, slash);
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}
