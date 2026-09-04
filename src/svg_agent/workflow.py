"""WorkflowController — orchestrates the read-think-write loop.

Pipeline: resolve target -> load context -> read state ->
classify instruction -> act (direct | propose) -> report verdict
"""

from __future__ import annotations

import re
from enum import Enum
from typing import TYPE_CHECKING

from svg_agent.conventions import ConventionStore
from svg_agent.markup import MarkupError, find_by_id, set_attribute

if TYPE_CHECKING:
    from svg_agent.client import HTTPClient


class IntentKind(str, Enum):
    OBVIOUS = "obvious"
    SUBJECTIVE = "subjective"
    STRUCTURAL = "structural"


_SUBJECTIVE_ADJS = frozenset({
    "bigger", "larger", "smaller", "cuter", "cooler", "calmer", "richer",
    "subtler", "bolder", "softer", "sharper", "brighter", "darker", "heavier",
    "lighter", "playful", "formal", "modern", "organic", "symmetrical",
    "spacious", "compact", "graceful", "angular", "curvier", "flatter",
    "cheery", "solemn", "gentler", "wilder", "polished", "rustic", "dreamier",
})

_GEOGRAPHICS = frozenset({
    "left", "right", "up", "down", "centre", "center", "middle", "edge",
    "horizontally", "vertically", "diagonally", "towards", "away",
    "higher", "lower", "forward", "backward",
})

_UNIT_MARKERS = ("px", "deg", "rad", "%", "vh", "vw", "em", "rem")

_STRUCTURAL_VERBS = ("add ", "remove ", "split ", "combine ", "clone ", "detach ")

_MOVE_RE = re.compile(
    r"^(?P<subject>\w[\w \-]*?)\s+(?P<way>up|down|left|right)"
    r"\s+(?P<magnitude>\d+(?:\.\d+)?(?:px|%)?)$"
)


def _has_unit(token: str) -> bool:
    """True iff the token carries a measurement suffix (CSS-unit shaped).

    Anchors to the END of the token so letters shared with ordinary words
    (e.g. ``rem`` inside ``remove``) do not masquerade as measurements.
    """
    return any(token.endswith(u) for u in _UNIT_MARKERS)


def classify(intention: str) -> IntentKind:
    """Bucket a free-text instruction into an intent kind."""
    lowered = intention.lower().strip()
    if not lowered:
        return IntentKind.SUBJECTIVE

    tokens = lowered.split()
    has_adjective = any(tk in _SUBJECTIVE_ADJS for tk in tokens)
    geo_hit = any(tk in _GEOGRAPHICS for tk in tokens)
    metric = any(_has_unit(tk) for tk in tokens)

    if has_adjective:
        return IntentKind.SUBJECTIVE
    if metric or geo_hit:
        return IntentKind.OBVIOUS
    if any(v in lowered for v in _STRUCTURAL_VERBS):
        return IntentKind.STRUCTURAL
    return IntentKind.SUBJECTIVE


class Verdict:
    """Outcome of acting on an instruction."""
    __slots__ = ("kind", "summary")

    def __init__(self, kind: IntentKind, summary: str) -> None:
        self.kind = kind
        self.summary = summary

    def as_dict(self) -> dict:
        return {"action": self.kind.value, "summary": self.summary}


class WorkflowController:
    """Drive one instruction through the read-think-write cycle."""

    def __init__(
        self,
        client: HTTPClient,
        store: ConventionStore | None = None,
        *,
        classifier=classify,
    ) -> None:
        self._client = client
        self.store = store or ConventionStore(client)
        self.classifier = classifier

    def resolve_project(self, hinted: str | None) -> str:
        return hinted if hinted else self._client.get_focus()

    def ensure_context(self) -> None:
        self.store.conventions()
        self.store.authoring()

    def run(self, instruction: str, project: str | None = None) -> Verdict:
        target = self.resolve_project(project)
        self.ensure_context()
        current = self._client.get_current(target)
        kind = self.classifier(instruction)

        if kind is IntentKind.OBVIOUS:
            revised = self.apply_direct(current, instruction)
            self._client.put_current(target, revised)
            return Verdict(kind, f"Applied direct edit to '{target}'.")

        variants = self.make_variants(instruction, current)
        posted = self._client.propose(target, variants)
        labels = [item.get("label", "?") for item in posted]
        return Verdict(kind, f"Posted {len(labels)} option(s) to '{target}'.")

    def apply_direct(self, current: str, instruction: str) -> str:
        match_obj = _MOVE_RE.fullmatch(instruction.lower().strip())
        if match_obj is None:
            raise MarkupError(
                f"Phrase not translatable to a direct edit: {instruction!r}"
            )
        subject = match_obj.group("subject")
        way = match_obj.group("way")
        amount_raw = match_obj.group("magnitude")
        amount_num = re.sub(r"(px|%)$", "", amount_raw)
        dx = f"-{amount_num}" if way == "left" else (amount_num if way == "right" else "0")
        dy = f"-{amount_num}" if way == "up" else (amount_num if way == "down" else "0")
        return _shift(subject, current, dx, dy)

    def make_variants(self, instruction: str, current: str) -> list[dict]:
        seed = _stable_hash(instruction, current)
        palette = ["baseline", "emphasis", "understated"]
        return [
            {"label": lbl, "svg": current, "salt": seed + idx}
            for idx, lbl in enumerate(palette)
        ]


def _stable_hash(left: str, right: str) -> int:
    """DJBX33A-inspired rolling hash with conventional constants."""
    acc = 5381
    for ch in f"{left}|{right}":
        acc = ((acc << 5) + acc) + ord(ch)
    return acc & 0xFFFFFFFF


def _shift(subject: str, current: str, dx: str, dy: str) -> str:
    info = find_by_id(current, subject)
    slot = current[info.attrs_start:info.attrs_end]
    match_obj = re.search(r'\btransform\s*=\s*["\'](.+?)["\']', slot, flags=re.IGNORECASE)
    if match_obj is None:
        return set_attribute(current, subject, "transform", f"translate({dx},{dy})")
    absorbed = _absorb(match_obj.group(1), dx, dy)
    return set_attribute(current, subject, "transform", absorbed)


def _absorb(old: str, dx: str, dy: str) -> str:
    m = re.search(r"translate\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)", old)
    if m is None:
        return f"translate({dx},{dy}) {old}".strip()
    px, py = float(m.group(1)), float(m.group(2))
    nx = px + float(dx)
    ny = py + float(dy)
    head = f"translate({_fmt(nx)},{_fmt(ny)})"
    tail = (old[:m.start()] + old[m.end():]).strip()
    return f"{head} {tail}".strip() if tail else head


def _fmt(n: float) -> str:
    return str(int(n)) if n == int(n) else repr(n)
