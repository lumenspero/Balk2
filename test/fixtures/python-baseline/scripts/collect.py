import json

from pipeline.normalize import run


def main():
    payload = [{"id": 1}, {"id": 2}]
    with open("data/raw.json", "w") as f:
        json.dump(payload, f)
    return run()
