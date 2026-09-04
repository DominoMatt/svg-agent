"""MarkupEngine — deterministic SVG string manipulation.

Pure-text utilities (standard-library only) for surgical edits to SVG
markup: locate an element by ``id``, set/clear attributes, prepend to
``transform``, and inject sibling nodes. Operates on raw strings so it
survives idiosyncratic serialisation (mixed quotes, irregular spacing)
while staying immune to DOM quirks.

Guarantees:
  * Edits alter only the targeted element's opening tag (attributes) or
    introduce peers adjacent to it (insert_before/insert_after); the rest
    of the document is byte-for-byte untouched.
  * Depth accounting recognises HTML/SVG void elements and self-closing
    tags, so ancestor scans terminate predictably.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Elements that never carry children; encountering one closes instantly.
VOID_ELEMENTS = frozenset({
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link",
    "meta", "param", "source", "track", "wbr",
})

_TOKENIZE_LT = re.compile(r"<")
_ID_EXTRACTOR = re.compile(r'''\bid\s*=\s*(["'])(.*?)\1''')

_NEWLINE_INNER = "\n"


@dataclass(frozen=True)
class TagInfo:
    """Coordinates of one element's opening tag within the source string."""

    tag: str
    open_start: int  # index of '<'
    open_end: int  # index JUST PAST the terminating '>' of the opening tag
    attrs_start: int  # index of first attribute char (past tagname + inter-space)
    attrs_end: int  # index just past the last attribute char
    self_closing: bool


class MarkupError(Exception):
    """Malformed or unmatched SVG markup blocked a safe edit."""


def iter_tags(source: str) -> list[tuple[int, int]]:
    """Pair every '<' with its terminating '>' as exclusive-span tuples."""
    out: list[tuple[int, int]] = []
    for lm in _TOKENIZE_LT.finditer(source):
        gt = source.find(">", lm.start())
        if gt == -1:
            break
        out.append((lm.start(), gt + 1))
    return out


def _split_head(body: str) -> tuple[str, str]:
    """Partition an opening-tag interior into (tagname, attribute-tail)."""
    stripped = body.lstrip()
    mobj = re.match(r"[_\-\w:]+", stripped)
    if mobj is None:
        raise MarkupError(f"Could not parse tag heading from {body!r}.")
    return mobj.group(0), stripped[mobj.end() :]


def describe_elements(source: str) -> list[TagInfo]:
    """Parse every element's opening tag into ordered ``TagInfo`` records."""
    infos: list[TagInfo] = []
    for lo, ro in iter_tags(source):
        interior = source[(lo + 1) : (ro - 1)]
        if interior.startswith(("/", "!", "?")):
            continue  # closing tags, declarations, processing instructions
        tag, tail = _split_head(interior)
        self_closing = tail.rstrip().endswith("/")
        trim_source = tail[:-1].rstrip() if self_closing else tail.rstrip()
        lead_space = len(tail) - len(tail.lstrip())
        attrs_start = lo + 1 + len(tag) + lead_space
        attrs_end = attrs_start + len(trim_source)
        infos.append(TagInfo(tag, lo, ro, attrs_start, attrs_end, self_closing))
    return infos


def find_by_id(source: str, elem_id: str) -> TagInfo:
    """Return the ``TagInfo`` of the first element whose ``id`` equals ``elem_id``."""
    for ti in describe_elements(source):
        interior = source[(ti.open_start + 1) : (ti.open_end - 1)]
        im = _ID_EXTRACTOR.search(interior)
        if im is not None and im.group(2) == elem_id:
            return ti
    raise MarkupError(f"No element with id={elem_id!r} found.")


def _slice_set(source: str, start: int, end: int, replacement: str) -> str:
    return source[:start] + replacement + source[end:]


def set_attribute(source: str, elem_id: str, name: str, value: str) -> str:
    """Assign ``name=\"value\"`` on the element, superseding any prior value."""
    ti = find_by_id(source, elem_id)
    slot = source[ti.attrs_start : ti.attrs_end]
    pattern = re.compile(
        rf'(?P<lead>\s*){re.escape(name)}\s*=\s*(?P<qv>["\']).*?(?P=qv)',
        flags=re.DOTALL | re.IGNORECASE,
    )
    rendered = f'{name}="{value}"'
    pm = pattern.search(slot)
    if pm is not None:
        rep = pm.group("lead") + rendered
        return _slice_set(source, ti.attrs_start + pm.start(), ti.attrs_start + pm.end(), rep)
    glue = "" if not slot or slot.endswith("/") else " "
    return _slice_set(source, ti.attrs_end, ti.attrs_end, glue + rendered)


def remove_attribute(source: str, elem_id: str, name: str) -> str:
    """Drop ``name`` (together with its separating whitespace) from the element."""
    ti = find_by_id(source, elem_id)
    slot = source[ti.attrs_start : ti.attrs_end]
    pattern = re.compile(
        rf'\s*{re.escape(name)}\s*=\s*(?P<qv>["\']).*?(?P=qv)', flags=re.DOTALL | re.IGNORECASE
    )
    pm = pattern.search(slot)
    if pm is None:
        return source
    return _slice_set(source, ti.attrs_start + pm.start(), ti.attrs_start + pm.end(), "")


def _read_transforms(source: str, elem_id: str) -> list[str]:
    ti = find_by_id(source, elem_id)
    slot = source[ti.attrs_start : ti.attrs_end]
    tm = re.search(r'\btransform\s*=\s*(["\'])(.*?)\1', slot, flags=re.DOTALL | re.IGNORECASE)
    if tm is None:
        return []
    return [tok for tok in tm.group(2).split() if tok]


def prepend_transform(source: str, elem_id: str, operators: str) -> str:
    """Lead the element's ``transform`` with ``operators``, preserving older ones."""
    existing = _read_transforms(source, elem_id)
    merged = " ".join([operators.strip(), *existing]).strip()
    return set_attribute(source, elem_id, "transform", merged)


def _boundary(source: str, ti: TagInfo) -> int:
    """Index just past the LAST '>' belonging to the element rooted at ``ti``."""
    if ti.self_closing or ti.tag.lower() in VOID_ELEMENTS:
        return ti.open_end
    depth = 1
    for lo, ro in ((pair) for pair in iter_tags(source) if pair[0] >= ti.open_end):
        interior = source[(lo + 1) : (ro - 1)].lstrip()
        if interior.startswith("/"):
            depth -= 1
            if depth == 0:
                return ro
        elif interior.startswith(("!", "?")):
            continue
        else:
            stag, _ = _split_head(interior)
            if stag.lower() in VOID_ELEMENTS or interior.rstrip().endswith("/"):
                continue
            depth += 1
    raise MarkupError(f"Element <{ti.tag}> unbalanced: no matching close.")


def insert_before(source: str, elem_id: str, markup: str) -> str:
    """Introduce ``markup`` as a sibling positioned immediately before the element."""
    ti = find_by_id(source, elem_id)
    return _slice_set(source, ti.open_start, ti.open_start, markup + _NEWLINE_INNER)


def insert_after(source: str, elem_id: str, markup: str) -> str:
    """Introduce ``markup`` as a sibling positioned immediately after the element."""
    ti = find_by_id(source, elem_id)
    bound = _boundary(source, ti)
    return _slice_set(source, bound, bound, _NEWLINE_INNER + markup)
