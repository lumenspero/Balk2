from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from helpers import Thing
try:
    import json_fast_missing as fast
except ImportError:
    import json as fast
