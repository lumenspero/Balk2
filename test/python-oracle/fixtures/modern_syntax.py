def generic[T: int, *Ts, **P](x: T) -> T:
    return x


type Pair[T] = tuple[T, T]


def dispatch(command):
    match command:
        case [action, *rest] if action == "go":
            return rest
        case {"key": value, **others}:
            return value, others
        case Point(x=0) | Point(y=0):
            return None
        case _:
            return f"{command!r:>{10}} {'nested'} {{literal}}"


try:
    run()
except* ValueError as group:
    report(group)
