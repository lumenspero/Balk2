import { assertUniqueNames, type CorpusScenario } from './corpus-types.js';

/**
 * Python-only forms and negatives. These cover what the parity corpus cannot: import-system
 * semantics, scoping and the syntax the V3 parser must accept. Every scenario is pending until its
 * phase lands, so the expectations below are targets.
 */
export const PYTHON_CORPUS: readonly CorpusScenario[] = [
  {
    name: 'from-import of a submodule versus an attribute',
    family: 'modules and imports',
    renditions: {
      python: {
        files: {
          'pkg/__init__.py': 'value = 1\n',
          'pkg/util.py': 'def helper():\n    return 1\n',
          'app.py': 'from pkg import util\nfrom pkg import value\n',
        },
        expect: {
          relationships: ['imports app.py -> pkg/util.py'],
          absent: ['imports app.py -> pkg/value.py'],
        },
      },
    },
  },

  {
    name: 'TYPE_CHECKING import is type-only',
    family: 'type-only imports',
    renditions: {
      python: {
        files: {
          'models.py': 'class User:\n    pass\n',
          'service.py':
            'from typing import TYPE_CHECKING\n\nif TYPE_CHECKING:\n    from models import User\n\n\ndef run(u: "User"):\n    return u\n',
        },
        expect: {
          relationships: ['imports service.py -> models.py'],
        },
      },
    },
  },

  {
    name: 'try/except ImportError fallback definitions are one symbol',
    family: 'conditional branches',
    renditions: {
      python: {
        files: {
          'fast.py': 'def dump(x):\n    return str(x)\n',
          'slow.py': 'def dump(x):\n    return repr(x)\n',
          'codec.py':
            'try:\n    from fast import dump\nexcept ImportError:\n    from slow import dump\n\n\ndef run():\n    return dump(1)\n',
        },
        expect: {
          relationships: [
            'imports codec.py -> fast.py',
            'imports codec.py -> slow.py',
            'calls codec.py:run -> fast.py:dump',
          ],
        },
      },
    },
  },

  {
    name: 'rebound alias is not followed (negative)',
    family: 'shadowing',
    renditions: {
      python: {
        files: {
          'a.py': 'def run():\n    return 1\n',
          'b.py': 'def run():\n    return 2\n',
          'app.py':
            'import a\n\nfn = a.run\nfn = __import__("b").run\n\n\ndef go():\n    return fn()\n',
        },
        expect: {
          relationships: ['imports app.py -> a.py'],
          // The name is rebound to a call result, so no static target exists. The map must not
          // point go() at a.run, and must report the rebinding as an unresolved observation.
          absent: ['calls app.py:go -> a.py:run'],
        },
      },
    },
  },

  {
    name: 'comprehension variable does not leak into the enclosing scope (negative)',
    family: 'shadowing',
    renditions: {
      python: {
        files: {
          'util.py': 'def item():\n    return 1\n',
          'app.py':
            'from util import item\n\n\ndef run(xs):\n    values = [item for item in xs]\n    return item()\n',
        },
        expect: {
          relationships: ['calls app.py:run -> util.py:item'],
        },
      },
    },
  },

  {
    name: 'decorator keeps the decorated function as the call target',
    family: 'decorators',
    renditions: {
      python: {
        files: {
          'deco.py': 'def wrap(fn):\n    return fn\n',
          'app.py':
            'from deco import wrap\n\n\n@wrap\ndef task():\n    return 1\n\n\ndef run():\n    return task()\n',
        },
        expect: {
          relationships: ['calls app.py:task -> deco.py:wrap', 'calls app.py:run -> app.py:task'],
        },
      },
    },
  },

  {
    name: 'match soft keyword used as an ordinary name',
    family: 'syntax',
    renditions: {
      python: {
        files: {
          'util.py': 'def helper():\n    return 1\n',
          'app.py':
            'from util import helper\n\nmatch = helper()\ncase = match\n\n\ndef run():\n    return case\n',
        },
        expect: {
          relationships: ['imports app.py -> util.py', 'calls app.py -> util.py:helper'],
          noSyntaxErrors: true,
        },
      },
    },
  },

  {
    name: 'f-string with nested quotes (PEP 701)',
    family: 'syntax',
    renditions: {
      python: {
        files: {
          'names.py': 'def label():\n    return "x"\n',
          'app.py':
            'from names import label\n\n\ndef run(d):\n    return f"{d["key"]} {label()}"\n',
        },
        expect: {
          relationships: ['calls app.py:run -> names.py:label'],
          noSyntaxErrors: true,
        },
      },
    },
  },

  {
    name: 'literal dynamic import is recorded; a computed name is an observation',
    family: 'dynamic module loads',
    renditions: {
      python: {
        files: {
          'plugins/alpha.py': 'def run():\n    return 1\n',
          'loader.py':
            'import importlib\n\n\ndef load_fixed():\n    return importlib.import_module("plugins.alpha")\n\n\ndef load_named(name):\n    return importlib.import_module(name)\n',
        },
        expect: {
          relationships: ['imports loader.py:load_fixed -> plugins/alpha.py'],
        },
      },
    },
  },
  {
    name: 'self and super calls resolve through the MRO',
    family: 'inheritance',
    renditions: {
      python: {
        files: {
          'base.py': 'class Base:\n    def run(self):\n        return 1\n',
          'mid.py':
            'from base import Base\n\n\nclass Mid(Base):\n    def run(self):\n        return super().run()\n',
          'app.py':
            'from mid import Mid\n\n\nclass App(Mid):\n    def go(self):\n        return self.run()\n',
        },
        expect: {
          relationships: [
            'extends mid.py:Mid -> base.py:Base',
            'calls mid.py:Mid.run -> base.py:Base.run',
            'calls app.py:App.go -> mid.py:Mid.run',
          ],
          absent: ['calls app.py:App.go -> base.py:Base.run'],
        },
      },
    },
  },

  {
    name: 'a class registered with an ABC implements it',
    family: 'inheritance',
    renditions: {
      python: {
        files: {
          'iface.py': 'import abc\n\n\nclass Shape(abc.ABC):\n    pass\n',
          'impl.py':
            'from iface import Shape\n\n\nclass Square:\n    pass\n\n\nShape.register(Square)\n',
        },
        expect: {
          relationships: ['implements impl.py:Square -> iface.py:Shape'],
        },
      },
    },
  },

  {
    name: 'an import of a namespace package resolves to its module',
    family: 'modules and imports',
    renditions: {
      python: {
        files: {
          'lib/helpers/util.py': 'def help():\n    return 1\n',
          'app.py': 'from lib.helpers.util import help\n\n\ndef main():\n    return help()\n',
        },
        expect: {
          relationships: [
            'imports app.py -> lib/helpers/util.py',
            'calls app.py:main -> lib/helpers/util.py:help',
          ],
        },
      },
    },
  },

  {
    name: 'a local name shadows a module function, so the call is not connected (negative)',
    family: 'shadowing',
    renditions: {
      python: {
        files: {
          'shadow.py':
            'def helper():\n    return 1\n\n\ndef run():\n    helper = lambda: 2\n    return helper()\n',
        },
        expect: {
          absent: ['calls shadow.py:run -> shadow.py:helper'],
        },
      },
    },
  },

  {
    name: 'a module global written through global is a module-level symbol',
    family: 'module-level state (D8)',
    renditions: {
      python: {
        files: {
          'state.py':
            'counter = 0\n\n\ndef bump():\n    global counter\n    counter = counter + 1\n    return counter\n',
        },
        expect: {
          symbols: ['state.py:counter', 'state.py:bump'],
        },
      },
    },
  },
];

assertUniqueNames(PYTHON_CORPUS);
