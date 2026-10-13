from __future__ import annotations

import re

# Booru tag spellings across sites that order personal names differently.
# Danbooru writes family name first (hirasawa_yui), e621 given name first
# (yui_hirasawa); either may carry a series qualifier (_(k-on!)).

_TWO_PART_NAME = re.compile(r"^(?P<first>[^_()]+)_(?P<second>[^_()]+)(?P<qualifier>_\([^()]+\))?$")


def swapped_name(spelling: str) -> str | None:
    """The other name order of a two-part name, keeping any qualifier; None otherwise."""
    match = _TWO_PART_NAME.match(spelling)
    if not match:
        return None
    return f"{match.group('second')}_{match.group('first')}{match.group('qualifier') or ''}"
