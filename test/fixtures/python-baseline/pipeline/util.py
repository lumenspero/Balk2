import json


class Base:
    def describe(self):
        return "base"


def helper(value):
    return json.dumps(value)
