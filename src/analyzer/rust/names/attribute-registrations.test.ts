import { describe, expect, it } from 'vitest';
import type { RegistryFact } from '../../../facts/types.js';
import type { RegistryAttributeRule } from '../../registry-protocols.js';
import { attributeRegistrations } from './attribute-registrations.js';
import { buildCrateIndex, type RustCrateIndex } from './module-index.js';

const FILE = 'crates/app/src/lib.rs';

function indexOf(source: string): RustCrateIndex {
  return buildCrateIndex({
    root: FILE,
    files: new Set([FILE]),
    readText: (file) => (file === FILE ? source : ''),
    edition: '2021',
  });
}

/** The declaration facts as `registry key -> item name`, reading the item name back from its id. */
function lines(source: string, rules: readonly RegistryAttributeRule[]): string[] {
  const index = indexOf(source);
  const facts = attributeRegistrations([{ index }], rules);
  return facts.map((fact: RegistryFact) => {
    if (fact.kind !== 'registry-declaration') return `other ${fact.kind}`;
    const key = fact.key.kind === 'static' ? fact.key.name : fact.key.kind;
    const item =
      fact.target
        .slice(fact.target.lastIndexOf(':') + 1)
        .split('::')
        .pop() ?? fact.target;
    return `${fact.registry} ${key} -> ${item}`;
  });
}

const COMMAND: RegistryAttributeRule = {
  name: 'tauri::command',
  key: 'fn-name',
  registry: 'commands',
};
const ROUTE: RegistryAttributeRule = { name: 'route', key: { arg: 0 }, registry: 'routes' };

describe('rust attribute registrations (V3 Phase 12.2)', () => {
  it('declares a free function under its own name for an fn-name rule', () => {
    expect(
      lines('#[tauri::command]\npub fn greet() -> String { String::new() }\n', [COMMAND]),
    ).toEqual(['commands greet -> greet']);
  });

  it('declares a free function under the string literal in its argument', () => {
    expect(lines('#[route("/users")]\npub fn users() {}\n', [ROUTE])).toEqual([
      'routes /users -> users',
    ]);
  });

  it('declares nothing for a function without the attribute', () => {
    expect(lines('pub fn plain() {}\n', [COMMAND])).toEqual([]);
  });

  it('declares nothing for a method, which is not read in this phase', () => {
    expect(
      lines('pub struct Api;\nimpl Api {\n    #[tauri::command]\n    pub fn ping(&self) {}\n}\n', [
        COMMAND,
      ]),
    ).toEqual([]);
  });

  it('declares nothing for a bare attribute under an arg rule, which has no argument', () => {
    expect(lines('#[route]\npub fn users() {}\n', [ROUTE])).toEqual([]);
  });
});
