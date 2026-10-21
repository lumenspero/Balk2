#!/usr/bin/env python3
"""CI oracle: dumps what CPython's ast sees in each Python file.

Usage: dump_inventory.py <root>

Prints one JSON object keyed by repository-relative path. The inventory format is
shared with src/analyzer/python/oracle-inventory.ts, so the two sides can be compared
line for line. Columns are not compared: CPython counts UTF-8 bytes and Balk2 counts
UTF-16 units, which differ on non-ASCII lines.
"""
import ast
import json
import pathlib
import sys


def chain(node):
    """A dotted name for a Name or an Attribute chain, otherwise '?'."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        base = chain(node.value)
        return "?" if base == "?" else f"{base}.{node.attr}"
    return "?"


def leaves(target):
    """The assignment leaves of a target, looking through tuples, lists and starred targets."""
    if isinstance(target, (ast.Tuple, ast.List)):
        for element in target.elts:
            yield from leaves(element)
    elif isinstance(target, ast.Starred):
        yield from leaves(target.value)
    else:
        yield target


def alias_text(alias):
    return alias.name if alias.asname is None else f"{alias.name} as {alias.asname}"


def inventory(source):
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return {"syntaxError": True, "definitions": [], "imports": [], "calls": [], "assignments": []}

    definitions, imports, calls, assignments = [], [], [], []
    type_alias = getattr(ast, "TypeAlias", None)
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            definitions.append(f"def {node.name}@{node.lineno}")
        elif isinstance(node, ast.ClassDef):
            definitions.append(f"class {node.name}@{node.lineno}")
        elif type_alias is not None and isinstance(node, type_alias):
            definitions.append(f"type {node.name.id}@{node.lineno}")
        elif isinstance(node, ast.Import):
            imports.append("import " + ",".join(alias_text(a) for a in node.names) + f"@{node.lineno}")
        elif isinstance(node, ast.ImportFrom):
            dots = "." * node.level
            body = "*" if node.names[0].name == "*" else ",".join(alias_text(a) for a in node.names)
            imports.append(f"from {dots}{node.module or ''} import {body}@{node.lineno}")
        elif isinstance(node, ast.Call):
            calls.append(f"call {chain(node.func)}@{node.lineno}")

        targets = []
        if isinstance(node, ast.Assign):
            targets = node.targets
        elif isinstance(node, (ast.AugAssign, ast.AnnAssign, ast.For, ast.AsyncFor, ast.NamedExpr)):
            targets = [node.target]
        elif isinstance(node, ast.withitem) and node.optional_vars is not None:
            targets = [node.optional_vars]
        elif isinstance(node, ast.comprehension):
            targets = [node.target]
        for target in targets:
            for leaf in leaves(target):
                assignments.append(f"assign {chain(leaf)}@{leaf.lineno}")

    return {
        "syntaxError": False,
        "definitions": sorted(definitions),
        "imports": sorted(imports),
        "calls": sorted(calls),
        "assignments": sorted(assignments),
    }


def main(argv):
    if len(argv) != 2:
        print(__doc__, file=sys.stderr)
        return 2
    root = pathlib.Path(argv[1])
    result = {}
    for path in sorted(root.rglob("*.py")):
        relative = path.relative_to(root).as_posix()
        result[relative] = inventory(path.read_bytes())
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
