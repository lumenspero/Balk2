/**
 * Rust attribute registrations (V3 Phase 12.2). An attribute named in `protocols.registries.attributes`
 * declares the free function or type it sits on: under the item's own name (`fn-name`), or under the
 * string or number literal in the attribute's argument at `arg`. `#[tauri::command] fn greet()`
 * declares `greet`, and `#[route("/users")] fn users()` declares `/users`.
 *
 * Methods in an `impl` or `trait` are not read: an attribute on one declares nothing in this phase.
 * A bare attribute has no argument, so only `fn-name` applies to it.
 */
import type { RegistryDeclarationFact, RegistryKeyFact } from '../../../facts/types.js';
import type { SourceSpan } from '../../../types.js';
import type { Attribute, Span } from '../items.js';
import type { RegistryAttributeRule } from '../../registry-protocols.js';
import { argumentParts } from './proc-macros.js';
import type { RustCrateIndex } from './module-index.js';

/** The registration facts for every configured attribute in the crates, in source order. */
export function attributeRegistrations(
  crates: readonly { readonly index: RustCrateIndex }[],
  rules: readonly RegistryAttributeRule[],
): RegistryDeclarationFact[] {
  if (rules.length === 0) return [];
  const facts: RegistryDeclarationFact[] = [];
  for (const crate of crates) {
    for (const fn of crate.index.functions) {
      if (fn.container !== null) continue;
      facts.push(...declarationsOf(fn.item.attrs, fn.item.name, fn.id, fn.owner.file, rules));
    }
    for (const decl of crate.index.decls) {
      facts.push(
        ...declarationsOf(decl.item.attrs, decl.item.name, decl.id, decl.owner.file, rules),
      );
    }
  }
  return facts;
}

function declarationsOf(
  attrs: readonly Attribute[],
  itemName: string,
  target: string,
  file: string,
  rules: readonly RegistryAttributeRule[],
): RegistryDeclarationFact[] {
  const out: RegistryDeclarationFact[] = [];
  for (const attr of attrs) {
    for (const rule of rules) {
      if (attr.path !== rule.name) continue;
      const key = keyOf(rule, attr, itemName);
      if (key === undefined) continue;
      out.push({
        kind: 'registry-declaration',
        filePath: file,
        span: sourceSpanOf(attr.span, file),
        source: 'decorator',
        subject: `#[${rule.name}]`,
        registry: rule.registry,
        key,
        target,
        targetInGraph: true,
        confidence: 'high',
        evidence: 'config',
      });
    }
  }
  return out;
}

function keyOf(
  rule: RegistryAttributeRule,
  attr: Attribute,
  itemName: string,
): RegistryKeyFact | undefined {
  if (rule.key === 'fn-name') {
    return {
      kind: 'static',
      name: itemName,
      keyType: 'string',
      numericLiteral: false,
      evidence: 'ast',
    };
  }
  const part = argumentParts(attr)[rule.key.arg];
  if (part === undefined) return undefined;
  const text = /^"(.*)"$/.exec(part);
  if (text !== null) {
    return {
      kind: 'static',
      name: text[1] ?? '',
      keyType: 'string',
      numericLiteral: false,
      evidence: 'ast',
    };
  }
  if (/^\d+$/.test(part)) {
    return { kind: 'static', name: part, keyType: 'number', numericLiteral: true, evidence: 'ast' };
  }
  return undefined;
}

function sourceSpanOf(span: Span, filePath: string): SourceSpan {
  return {
    filePath,
    startLine: span.line,
    startColumn: span.column,
    endLine: span.endLine,
    endColumn: span.endColumn,
  };
}
