import functools


@functools.lru_cache(maxsize=None)
def outer(a, b=lambda x: x + 1):
    total = a
    total += b(1)
    value: int = total
    with open("f") as handle, open("g"):
        handle.write(str(value))
    for index, (left, right) in enumerate([(1, 2)]):
        print(index, left, right)
    if (count := len([i for i in range(3) if i > 0])) > 1:
        return count
    return {k: v for k, v in {}.items()}


async def fetch(url):
    async with session(url) as response:
        await response.read()
    return [item async for item in stream(url)]


class Base:
    attribute = 1

    class Nested:
        def method(self):
            self.attribute.bit_length()
            return super().__init__()

    def __init__(self, *args, **kwargs):
        self.items[0] = args[0]
        self.name, *rest = kwargs.values()
