import os
from typing import Any

def foo(x: int) -> int:
    return x + 1

class Bar(Foo):
    """A subclass."""
    def baz(self) -> Any:
        foo(1)
        return os.getcwd()
