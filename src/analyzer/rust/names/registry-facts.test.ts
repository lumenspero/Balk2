import { describe, expect, it } from 'vitest';
import type { RegistryCallFact, RegistryFact, RegistryKeyFact } from '../../../facts/types.js';
import { buildCrateIndex, type RustCrateIndex } from './module-index.js';
import { rustRegistryFacts } from './registry-facts.js';

const FILE = 'crates/app/src/lib.rs';
const ENV = { externs: new Set<string>(), repoCrates: new Map() };

function indexOf(source: string): RustCrateIndex {
  return buildCrateIndex({
    root: FILE,
    files: new Set([FILE]),
    readText: (file) => (file === FILE ? source : ''),
    edition: '2021',
  });
}

function keyText(key: RegistryKeyFact): string {
  if (key.kind === 'static') return key.name;
  return key.kind === 'dynamic' ? `dynamic:${key.reason}` : 'not-a-name';
}

/**
 * One line per call: `relationship key scope [-> target]`. A scope reads as its function name and
 * local, such as `lookup.map`, and a target as the item's name.
 */
function lines(source: string): string[] {
  const index = indexOf(source);
  const names = new Map<string, string>([
    ...index.functions.map((f): [string, string] => [f.id, f.item.name]),
    ...index.decls.map((d): [string, string] => [d.id, d.item.name]),
  ]);
  const fnIds = index.functions.map((f) => [f.item.name, f.id] as const);
  const label = (scope: string): string => {
    const decl = index.decls.find((d) => d.id === scope);
    if (decl !== undefined) return decl.item.name;
    const hit = fnIds.find(([, id]) => scope.startsWith(id));
    return hit === undefined ? scope : `${hit[0]}${scope.slice(hit[1].length)}`;
  };
  return rustRegistryFacts([index], ENV).map((fact: RegistryFact) => {
    if (fact.kind !== 'registry-call') return `other ${fact.kind}`;
    const call: RegistryCallFact = fact;
    const scope =
      call.receiver.identity.kind === 'resolved' ? label(call.receiver.identity.scope) : '?';
    const target = call.target === undefined ? '' : ` -> ${names.get(call.target) ?? call.target}`;
    return `${call.relationship} ${keyText(call.key)} ${scope}${target}`;
  });
}

describe('rust registry facts: local maps (V3 Phase 12.2)', () => {
  it('reads an insert on a map annotated as a HashMap as a registration', () => {
    expect(
      lines(
        'pub struct User;\npub fn lookup() {\n    let mut map: HashMap<&str, User> = HashMap::new();\n    map.insert("user", User);\n}\n',
      ),
    ).toEqual(['registers user lookup.map -> User']);
  });

  it('reads an insert, contains_key and get on a map built by its constructor', () => {
    expect(
      lines(
        'pub struct User;\npub fn lookup() -> bool {\n    let mut map = HashMap::new();\n    map.insert("user", User);\n    map.contains_key("user") && map.get("user").is_some()\n}\n',
      ),
    ).toEqual([
      'registers user lookup.map -> User',
      'resolves user lookup.map',
      'resolves user lookup.map',
    ]);
  });

  it('reads entry followed by or_insert as a registration of the value', () => {
    expect(
      lines(
        'pub struct User;\npub fn lookup() {\n    let mut map = BTreeMap::new();\n    map.entry("user").or_insert(User);\n}\n',
      ),
    ).toEqual(['registers user lookup.map -> User']);
  });

  it('reads an integer literal as a number key', () => {
    expect(
      lines(
        'pub struct User;\npub fn lookup() {\n    let mut map = HashMap::new();\n    map.insert(1, User);\n}\n',
      ),
    ).toEqual(['registers 1 lookup.map -> User']);
  });

  it('reads a key that is a variable as a dynamic key', () => {
    expect(
      lines(
        'pub struct User;\npub fn store(name: &str) {\n    let mut map = HashMap::new();\n    map.insert(name, User);\n}\n',
      ),
    ).toEqual(['registers dynamic:key is not a literal store.map -> User']);
  });

  it('gives no fact for a local that is not a map', () => {
    expect(
      lines(
        'pub struct User;\npub fn lookup() {\n    let mut v = Vec::new();\n    v.insert(0, User);\n}\n',
      ),
    ).toEqual([]);
  });

  it('gives no fact for a map name bound twice in the same function', () => {
    expect(
      lines(
        'pub struct User;\npub fn lookup() {\n    let map = HashMap::new();\n    let map = 5;\n    map.insert("user", User);\n}\n',
      ),
    ).toEqual([]);
  });

  it('gives no registration for a value that is not a repository symbol', () => {
    expect(
      lines(
        'pub fn lookup() {\n    let mut map = HashMap::new();\n    map.insert("user", 1);\n}\n',
      ),
    ).toEqual([]);
  });
});

describe('rust registry facts: statics that build a map (V3 Phase 12.2)', () => {
  const LAZY = 'pub struct User;\n';

  it('reads inserts in a LazyLock initializer as registrations into the static', () => {
    expect(
      lines(
        `${LAZY}pub static REGISTRY: LazyLock<HashMap<&str, User>> = LazyLock::new(|| {\n    let mut m = HashMap::new();\n    m.insert("user", User);\n    m\n});\n`,
      ),
    ).toEqual(['registers user REGISTRY -> User']);
  });

  it('gives no fact for a static whose value builds no map', () => {
    expect(lines(`${LAZY}pub static NAME: &str = "x";\n`)).toEqual([]);
  });

  it('reads nothing for a static that builds two maps, which is ambiguous', () => {
    expect(
      lines(
        `${LAZY}pub static REGISTRY: LazyLock<(HashMap<&str, User>, HashMap<&str, User>)> = LazyLock::new(|| {\n    let mut a = HashMap::new();\n    let mut b = HashMap::new();\n    a.insert("user", User);\n    b.insert("admin", User);\n    (a, b)\n});\n`,
      ),
    ).toEqual([]);
  });

  it('reads a non-literal key in a static initializer as a dynamic key', () => {
    expect(
      lines(
        `${LAZY}pub static REGISTRY: LazyLock<HashMap<&str, User>> = LazyLock::new(|| {\n    let mut m = HashMap::new();\n    m.insert(name(), User);\n    m\n});\n`,
      ),
    ).toEqual(['registers dynamic:key is not a literal REGISTRY -> User']);
  });
});
