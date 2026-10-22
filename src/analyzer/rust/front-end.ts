/**
 * The Rust front end (V3 Phase 9.1). It parses each Rust file and writes its named items to the
 * graph as symbols, the same way the Python front end does. Calls, imports and references come in
 * later sub-phases (9.3, 9.6, 9.7).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { ConnectionGraph } from '../../graph.js';
import { normalizePath } from '../../graph.js';
import type {
  FrontEndInput,
  FrontEndLanguage,
  FrontEndResult,
  LanguageFrontEnd,
} from '../front-end.js';
import type { SyntaxErrorNote } from '../repository-program.js';
import { parseRustFile } from './items.js';
import { analyzeRustSymbols } from './symbols.js';

function isRustPath(filePath: string): boolean {
  return normalizePath(filePath).toLowerCase().endsWith('.rs');
}

export class RustFrontEnd implements LanguageFrontEnd {
  readonly name = 'RustFrontEnd';
  readonly languages: readonly FrontEndLanguage[] = ['rust'];

  canHandle(filePath: string): boolean {
    return isRustPath(filePath);
  }

  analyze(input: FrontEndInput, graph: ConnectionGraph): FrontEndResult {
    const syntaxErrors: SyntaxErrorNote[] = [];
    for (const relFile of input.files) {
      const filePath = normalizePath(relFile);
      if (!this.canHandle(filePath)) continue;
      let source: string;
      try {
        source = fs.readFileSync(path.join(input.rootDir, relFile), 'utf8');
      } catch {
        // Skip unreadable files, as the other front ends do.
        continue;
      }
      // The parser recovers past each error, so every file is still analyzed.
      const file = parseRustFile(source);
      for (const e of file.errors) {
        syntaxErrors.push({ path: filePath, line: e.line, column: e.column, message: e.message });
      }
      graph.addFile(filePath, 'rust');
      for (const declaration of analyzeRustSymbols(file, filePath).declarations) {
        graph.addSymbol(filePath, declaration.name, declaration.symbolType);
      }
    }
    return { problems: [], syntaxErrors };
  }
}
