import {
  appliesTo,
  JS_TS_LANGUAGES,
  scopeEvents,
  scopeRegistries,
} from '../config/protocol-scope.js';
import { pathBaseOrder } from '../config/path-base-config.js';
import { normalizePath, type ConnectionGraph } from '../graph.js';
import type {
  FrontEndInput,
  FrontEndLanguage,
  FrontEndResult,
  LanguageFrontEnd,
} from './front-end.js';
import { JsTsAnalyzer } from './js-ts-analyzer.js';
import { jsTsBindings } from './js-ts-bindings.js';
import { jsTsProcesses } from './process/js-ts-processes.js';
import { createRepositoryProgram } from './repository-program.js';
import { collectSourceAnnotations } from './source-annotations-apply.js';

/**
 * Parses and analyzes every JS/TS file in one shared repository session, and reads their source
 * annotations from the same session. The mechanism detectors still run inside `analyzeRepository`
 * until Phase 2 moves them onto the shared facts layer.
 */
export class JsTsFrontEnd implements LanguageFrontEnd {
  readonly name = 'JsTsFrontEnd';
  readonly languages: readonly FrontEndLanguage[] = ['javascript', 'typescript'];
  private readonly analyzer = new JsTsAnalyzer();

  canHandle(filePath: string): boolean {
    return this.analyzer.canAnalyze(filePath);
  }

  analyze(input: FrontEndInput, graph: ConnectionGraph): FrontEndResult {
    const files = input.files.filter((filePath) => this.canHandle(filePath));
    if (files.length === 0) {
      return { problems: [], syntaxErrors: [] };
    }

    const config = input.config;
    const repository = createRepositoryProgram({ rootDir: input.rootDir, filePaths: files });
    const analysis = this.analyzer.analyzeRepository(repository, graph, {
      dataPaths: new Set(input.files.map(normalizePath)),
      pathBase: pathBaseOrder(config, 'javascript'),
      globals: config?.globals,
      events: scopeEvents(config?.protocols?.events, JS_TS_LANGUAGES),
      registries: scopeRegistries(config?.protocols?.registries, JS_TS_LANGUAGES),
      loaders: appliesTo(config?.protocols?.loaders, JS_TS_LANGUAGES),
      callbacks: appliesTo(config?.protocols?.callbacks, JS_TS_LANGUAGES),
      metadata: appliesTo(config?.protocols?.metadata, JS_TS_LANGUAGES),
      resources: appliesTo(config?.protocols?.resources, JS_TS_LANGUAGES),
      state: config?.state,
    });

    return {
      problems: analysis.stateProblems,
      syntaxErrors: repository.syntaxErrors(),
      sourceAnnotations: collectSourceAnnotations(repository, []),
      bindings: jsTsBindings(repository),
      processes: jsTsProcesses(repository),
    };
  }
}
