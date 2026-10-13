"""Keep a split module behaving like the single module it replaced.

When a large module is split into parts, the original module re-exports the
moved names, but callers that moved into a part look names up in the part's
own globals. ``mock.patch("app.x.name")`` (or any assignment to ``app.x.name``)
would then rebind only the original module's copy and miss those callers.

``mirror_rebinding`` makes the original module propagate every rebinding to
each part that holds the same object under that name, so patching the old path
reaches the moved callers exactly as it did before the split.
"""
from __future__ import annotations

import sys
import types
from collections.abc import Iterable

_MISSING = object()


class _SplitModule(types.ModuleType):
    def __setattr__(self, name: str, value) -> None:
        old = self.__dict__.get(name, _MISSING)
        super().__setattr__(name, value)
        if old is _MISSING or name.startswith("__"):
            return
        for part in self.__dict__.get("__split_parts__", ()):
            if part.__dict__.get(name, _MISSING) is old:
                setattr(part, name, value)


def mirror_rebinding(module_name: str, parts: Iterable[types.ModuleType]) -> None:
    module = sys.modules[module_name]
    module.__dict__["__split_parts__"] = tuple(parts)
    module.__class__ = _SplitModule
