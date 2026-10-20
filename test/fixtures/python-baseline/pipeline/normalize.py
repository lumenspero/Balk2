import importlib
import json

from pipeline.util import helper


def run():
    with open("data/raw.json") as handle:
        records = json.load(handle)
    cleaned = [helper(r) for r in records]
    with open("data/normalized.json", "w") as out:
        json.dump(cleaned, out)
    importlib.import_module("pipeline.util")
    return cleaned
