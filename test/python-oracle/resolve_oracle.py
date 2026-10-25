#!/usr/bin/env python3
"""
The importlib oracle for Python import resolution (V3 Phase 4.6).

Usage: resolve_oracle.py <cases-dir>, which prints JSON keyed by case name. Each case directory
holds a case.json whose "roots" are the import roots, in order, and the .py files to check.

For every import statement, this asks CPython's own import machinery what the statement would load,
and records the answer. Balk2 is never consulted, so the output is an independent oracle. Each probe
starts from a clean module table, so one import cannot change the answer for another. Each case runs
in its own process for the same reason.
"""

import ast
import importlib
import importlib.util
import json
import os
import subprocess
import sys

sys.dont_write_bytecode = True  # the fixtures are imported; keep the tree free of __pycache__


def py_files(directory):
    found = []
    for dirpath, dirnames, filenames in os.walk(directory):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "__pycache__"]
        for name in filenames:
            if name.endswith(".py"):
                full = os.path.join(dirpath, name)
                found.append(os.path.relpath(full, directory).replace(os.sep, "/"))
    return sorted(found)


class Case:
    def __init__(self, directory, roots):
        self.directory = directory
        self.roots = roots
        self.base = set(sys.modules)

    def fresh(self):
        # Forget only modules loaded from this case. Standard library and interpreter modules stay:
        # removing them can crash the interpreter (seen on real repositories under CPython 3.10 and 3.12).
        for name in list(sys.modules):
            if name in self.base:
                continue
            file = getattr(sys.modules[name], "__file__", None) or ""
            if file.startswith(self.directory + os.sep):
                del sys.modules[name]
        importlib.invalidate_caches()

    def locate(self, origin):
        full = os.path.abspath(origin)
        if full.startswith(self.directory + os.sep):
            rel = os.path.relpath(full, self.directory).replace(os.sep, "/")
            return {"kind": "file", "path": rel}
        return {"kind": "external"}

    def internal(self, top):
        return any(
            os.path.exists(os.path.join(root, top)) or os.path.exists(os.path.join(root, top + ".py"))
            for root in self.roots
        )


def find_spec_or_none(name):
    try:
        return importlib.util.find_spec(name)
    except (ImportError, ValueError):
        return None


def probe_module(case, name):
    case.fresh()
    spec = find_spec_or_none(name)
    if spec is None:
        kind = "unresolved" if case.internal(name.split(".")[0]) else "external"
        return {"kind": kind}
    if spec.origin in (None, "namespace"):
        return {"kind": "namespace"}
    return dict(case.locate(spec.origin), via="whole")


def safe_getattr(obj, name):
    """getattr that treats any error as a missing attribute (lazy objects such as Django settings can raise)."""
    try:
        return getattr(obj, name, None)
    except Exception:
        return None


def probe_from(case, absname, alias):
    case.fresh()
    try:
        module = importlib.import_module(absname)
    except Exception:
        # A module that is not installed is external, the same as in probe_module.
        return {"kind": "unresolved" if case.internal(absname.split(".")[0]) else "external"}
    try:
        has_attribute = hasattr(module, alias)
    except Exception:
        # Reading the attribute can raise (Django's settings object does without configuration). The name is still bound in the module.
        has_attribute = alias in vars(module)
    if has_attribute:
        try:
            value = getattr(module, alias)
        except Exception:
            value = vars(module).get(alias)
        if safe_getattr(value, "__name__") == absname + "." + alias and safe_getattr(value, "__file__"):
            # The attribute is the submodule itself, so its origin is the submodule's own file.
            return dict(case.locate(value.__file__), via="submodule")
        origin = getattr(module, "__file__", None)
        if origin is None:
            # A built-in or frozen module has no file, but its names still come from the standard library.
            spec = getattr(module, "__spec__", None)
            if spec is not None and spec.origin in ("built-in", "frozen"):
                return {"kind": "external", "via": "attribute"}
            return {"kind": "namespace"}
        return dict(case.locate(origin), via="attribute")
    spec = find_spec_or_none(absname + "." + alias)
    if spec is None:
        return {"kind": "unresolved"}
    if spec.origin in (None, "namespace"):
        return {"kind": "namespace"}
    return dict(case.locate(spec.origin), via="submodule")


def probe_star(case, absname):
    case.fresh()
    namespace = {}
    try:
        exec("from " + absname + " import *", namespace)
    except Exception:
        return {"kind": "unresolved"}
    names = sorted(key for key in namespace if key != "__builtins__")
    spec = find_spec_or_none(absname)
    if spec is None or spec.origin in (None, "namespace"):
        return {"kind": "namespace", "names": names}
    return dict(case.locate(spec.origin), via="star", names=names)


def package_of(rel, directory, roots):
    full = os.path.join(directory, rel)
    for root in roots:
        if full.startswith(root + os.sep):
            inside = os.path.relpath(full, root).replace(os.sep, "/")
            return ".".join(inside.split("/")[:-1])
    return ""


def run_case(directory):
    with open(os.path.join(directory, "case.json"), encoding="utf-8") as handle:
        config = json.load(handle)
    directory = os.path.abspath(directory)
    roots = [os.path.abspath(os.path.join(directory, root)) for root in config["roots"]]
    # The repository roots come first, then the interpreter's own path (standard library and site
    # packages). The oracle's own directory is left out, so its scripts cannot shadow fixture names.
    here = os.path.dirname(os.path.abspath(__file__))
    interpreter_path = [p for p in sys.path if os.path.abspath(p or ".") != here]
    sys.path[:] = roots + [p for p in interpreter_path if p not in roots]
    case = Case(directory, roots)
    entries = []
    for rel in py_files(directory):
        path = os.path.join(directory, rel)
        with open(path, encoding="utf-8") as handle:
            tree = ast.parse(handle.read(), filename=path)
        package = package_of(rel, directory, roots)
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    bound = alias.asname or alias.name.split(".")[0]
                    probe = probe_module(case, alias.name)
                    entries.append(dict(file=rel, line=node.lineno, name=bound, **probe))
            elif isinstance(node, ast.ImportFrom):
                try:
                    dotted = "." * node.level + (node.module or "")
                    absname = importlib.util.resolve_name(dotted, package) if node.level else node.module
                except Exception:
                    absname = None
                for alias in node.names:
                    if alias.name == "*":
                        probe = probe_star(case, absname) if absname else {"kind": "unresolved"}
                        entries.append(dict(file=rel, line=node.lineno, name="*", **probe))
                    else:
                        probe = probe_from(case, absname, alias.name) if absname else {"kind": "unresolved"}
                        local = alias.asname or alias.name
                        entries.append(dict(file=rel, line=node.lineno, name=local, **probe))
    entries.sort(key=lambda e: (e["file"], e["line"], e["name"]))
    return entries


def main(argv):
    if len(argv) == 3 and argv[1] == "--case":
        json.dump(run_case(argv[2]), sys.stdout, sort_keys=True)
        return
    cases_dir = argv[1]
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    results = {}
    for name in sorted(os.listdir(cases_dir)):
        directory = os.path.join(cases_dir, name)
        if not os.path.isfile(os.path.join(directory, "case.json")):
            continue
        out = subprocess.run(
            [sys.executable, os.path.abspath(__file__), "--case", directory],
            capture_output=True,
            text=True,
            check=True,
            env=env,
        )
        results[name] = json.loads(out.stdout)
    json.dump(results, sys.stdout, indent=1, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv)
