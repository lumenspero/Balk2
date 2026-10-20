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
import { PythonAnalyzer } from './python-analyzer.js';

/**
 * TEMPORARY adapter (Phase 1.1, removed in Phase 5.7). Runs the line-based PythonAnalyzer one file
 * at a time behind LanguageFrontEnd. Behavior matches the per-file loop it replaces.
 */
export class LegacyPythonFrontEnd implements LanguageFrontEnd {
  readonly name = 'LegacyPythonFrontEnd';
  readonly languages: readonly FrontEndLanguage[] = ['python'];
  private readonly analyzer = new PythonAnalyzer();

  canHandle(filePath: string): boolean {
    return this.analyzer.canAnalyze(filePath);
  }

  analyze(input: FrontEndInput, graph: ConnectionGraph): FrontEndResult {
    const sourceTexts = new Map<string, string>();
    for (const relFile of input.files) {
      if (!this.canHandle(relFile)) continue;
      try {
        const content = fs.readFileSync(path.join(input.rootDir, relFile), 'utf8');
        sourceTexts.set(normalizePath(relFile), content);
        this.analyzer.analyzeFile(relFile, content, graph, {
          rootDir: input.rootDir,
          knownFiles: input.files,
        });
      } catch {
        // Skip unreadable files gracefully, as the former per-file loop did.
      }
    }
    return { problems: [], syntaxErrors: [], sourceTexts };
  }
}
