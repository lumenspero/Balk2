import { describe, expect, it } from 'vitest';
import type { RegistryCallFact, RegistryFact, RegistryKeyFact } from '../../../facts/types.js';
import { buildCrateIndex, type RustCrateIndex } from './module-index.js';
import { rustRegistryFacts } from './registry-facts.js';
import type { RegistryProtocol } from '../../registry-protocols.js';

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
function lines(source: string, methods: readonly RegistryProtocol[] = []): string[] {
  const index = indexOf(source);
  const names = new Map<string, string>([
    ...index.functions.map((f): [string, string] => [f.id, f.item.name]),
    ...index.decls.map((d): [string, string] => [d.id, d.item.name]),
  ]);
  const fnIds = index.functions.map((f) => [f.item.name, f.id] as const);
  const label = (scope: string): string => {
    const decl = index.decls.find((d) => d.id === scope);
    if (decl !== undefined) return decl.item.name;
    if (scope.startsWith(`${FILE}:`) && !scope.includes('.', FILE.length)) {
      return scope.slice(FILE.length + 1);
    }
    const hit = fnIds.find(([, id]) => scope.startsWith(id));
    return hit === undefined ? scope : `${hit[0]}${scope.slice(hit[1].length)}`;
  };
  return rustRegistryFacts([index], ENV, methods).map((fact: RegistryFact) => {
    if (fact.kind === 'registry-declaration') {
      const target = names.get(fact.target) ?? fact.target;
      return `declare ${keyText(fact.key)} ${label(fact.registry)} -> ${target}`;
    }
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

describe('rust registry facts: phf tables and lazy_static blocks (V3 Phase 12.2)', () => {
  const USER = 'pub struct User;\npub struct Admin;\n';

  it('reads each literal key of a phf_map static as a declaration', () => {
    expect(
      lines(
        `${USER}pub static REGISTRY: phf::Map<&str, Kind> = phf_map! {\n    "user" => User,\n    "admin" => Admin,\n};\n`,
      ),
    ).toEqual(['declare user REGISTRY -> User', 'declare admin REGISTRY -> Admin']);
  });

  it('gives no declaration for a phf entry whose value is not a repository symbol', () => {
    expect(
      lines(`${USER}pub static REGISTRY: phf::Map<&str, u32> = phf_map! {\n    "user" => 1,\n};\n`),
    ).toEqual([]);
  });

  it('reads a lookup of a phf static from a function of the same file', () => {
    expect(
      lines(
        `${USER}pub static REGISTRY: phf::Map<&str, Kind> = phf_map! {\n    "user" => User,\n};\npub fn find() -> bool {\n    REGISTRY.contains_key("user")\n}\n`,
      ),
    ).toEqual(['declare user REGISTRY -> User', 'resolves user REGISTRY']);
  });

  it('reads a lookup of a LazyLock static built by inserts', () => {
    expect(
      lines(
        `${USER}pub static REGISTRY: LazyLock<HashMap<&str, User>> = LazyLock::new(|| {\n    let mut m = HashMap::new();\n    m.insert("user", User);\n    m\n});\npub fn find() -> bool {\n    REGISTRY.get("user").is_some()\n}\n`,
      ),
    ).toEqual(['registers user REGISTRY -> User', 'resolves user REGISTRY']);
  });

  it('gives no registration for an insert into a static from a function', () => {
    expect(
      lines(
        `${USER}pub static REGISTRY: LazyLock<HashMap<&str, User>> = LazyLock::new(|| {\n    HashMap::new()\n});\npub fn add() {\n    REGISTRY.insert("user", User);\n}\n`,
      ),
    ).toEqual([]);
  });

  it('reads the statics of a lazy_static block as registries', () => {
    expect(
      lines(
        `${USER}lazy_static! {\n    static ref REGISTRY: HashMap<&str, User> = {\n        let mut m = HashMap::new();\n        m.insert("user", User);\n        m\n    };\n}\npub fn find() -> bool {\n    REGISTRY.contains_key("user")\n}\n`,
      ),
    ).toEqual(['registers user REGISTRY -> User', 'resolves user REGISTRY']);
  });
});

describe('rust registry facts: configured bare calls (V3 Phase 12.2)', () => {
  const USER = 'pub struct User;\n';
  const ROUTES: readonly RegistryProtocol[] = [
    { method: 'navigate', direction: 'route', keyArg: 0, registry: 'routes' },
    { method: 'bind', direction: 'register', keyArg: 0, valueArg: 1, registry: 'commands' },
  ];

  it('reads a bare call of a configured route method as routesTo', () => {
    expect(lines(`${USER}pub fn go() {\n    navigate("/users");\n}\n`, ROUTES)).toEqual([
      'routesTo /users routes',
    ]);
  });

  it('reads a bare call of a configured register method as a registration of its value', () => {
    expect(lines(`${USER}pub fn setup() {\n    bind("user", User);\n}\n`, ROUTES)).toEqual([
      'registers user commands -> User',
    ]);
  });

  it('does not match a method called on a receiver', () => {
    expect(
      lines(`${USER}pub fn go(page: Page) {\n    page.navigate("/users");\n}\n`, ROUTES),
    ).toEqual([]);
  });

  it('reads nothing when no method is configured with a registry', () => {
    expect(lines(`${USER}pub fn go() {\n    navigate("/users");\n}\n`)).toEqual([]);
  });
});
