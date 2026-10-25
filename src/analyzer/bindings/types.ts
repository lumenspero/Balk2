import type { SourceSpan } from '../../types.js';

/**
 * A mechanism that connects two languages through a named interface (V3 Phase 14). Each kind
 * names the framework that generates the interface, so a consumer and a producer match only when
 * they agree on the kind as well as the specifier.
 */
export type BindingKind = 'wasm-bindgen' | 'pyo3' | 'napi';

/** The language a binding side is written in. A binding joins the two sides, never one side to itself. */
export type BindingSide = 'rust' | 'javascript' | 'python';

/** A name a producer exposes to another language, such as a `#[wasm_bindgen]` export. */
export interface BindingExport {
  readonly kind: BindingKind;
  readonly side: BindingSide;
  /** The module or package a consumer imports from: a package name or a repository-relative path. */
  readonly specifier: string;
  /** The name as the consumer sees it, after renames such as `js_name`. */
  readonly name: string;
  /** Symbol id of the producer's declaration. */
  readonly symbolId: string;
  /** Repository-relative file that declares the producer. */
  readonly file: string;
  readonly confidence: 'high' | 'medium';
}

/** A name a consumer imports from another language's producer. */
export interface BindingConsumer {
  readonly kind: BindingKind;
  readonly side: BindingSide;
  readonly specifier: string;
  readonly name: string;
  /** Repository-relative file that contains the import. */
  readonly file: string;
  readonly span: SourceSpan;
  /** The symbol that uses the binding, when it is a declaration (a Rust extern fn). Undefined means the file. */
  readonly owner?: string;
}

/** The bindings one front end publishes: what its files produce and what they consume. */
export interface FrontEndBindings {
  readonly exports: readonly BindingExport[];
  readonly consumers: readonly BindingConsumer[];
}

/**
 * The outcome of matching one consumer against the index.
 *
 * - `matched`: exactly one producer on the other side exports the name.
 * - `ambiguous`: more than one producer exports the name. The candidates are listed, never guessed.
 * - `missing-name`: a producer publishes this specifier but does not export the name (V3 14.6).
 * - `no-producer`: no producer on the other side publishes this specifier.
 */
export type BindingMatch =
  | { readonly status: 'matched'; readonly export: BindingExport }
  | { readonly status: 'ambiguous'; readonly candidates: readonly BindingExport[] }
  | { readonly status: 'missing-name' }
  | { readonly status: 'no-producer' };
