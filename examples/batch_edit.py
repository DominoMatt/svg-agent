#!/usr/bin/env python3
"""Batch edits — apply a sequence of structural edits to a project.

Demonstrates the HTTPClient + MarkupEngine pipeline for deterministic,
idempotent changes that need no LLM and no human confirmation.

Usage:
    python examples/batch_edit.py [PROJECT] [--server URL]

Requires a running SVG Studio server on the given URL (default :3000).
"""

from __future__ import annotations

import argparse
import sys

import httpx

from svg_agent.client import HTTPClient
from svg_agent.markup import MarkupError, prepend_transform, remove_attribute, set_attribute

# ── Edit recipe ──────────────────────────────────────────────────────────────

# Each tuple is (operation, element_id, payload).
#   SET   — set an attribute to a value
#   DROP  — remove an attribute
#   TX    — prepend transform operations
EDITS: list[tuple[str, str, str]] = [
    ("SET", "body", "fill=#e0f0ff"),
    ("SET", "body", "stroke=#336"),
    ("SET", "body", "stroke-width=2"),
    ("TX", "eye", "translate(0,-3)"),
    ("DROP", "body", "filter"),
]


def apply_one(current: str, op: str, elem: str, payload: str) -> str:
    """Dispatch a single edit operation against the SVG string."""
    if op == "SET":
        attr, _, value = payload.partition("=")
        if not value:
            raise MarkupError(f"SET requires ATTR=VALUE, got {payload!r}")
        return set_attribute(current, elem, attr, value)
    if op == "DROP":
        return remove_attribute(current, elem, payload)
    if op == "TX":
        return prepend_transform(current, elem, payload)
    raise MarkupError(f"Unknown operation {op!r}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project", nargs="?", default="fish", help="project name (default: fish)")
    ap.add_argument("--server", default="http://localhost:3000", help="SVG Studio base URL")
    args = ap.parse_args()

    try:
        with HTTPClient(args.server) as api:
            current = api.get_current(args.project)
            print(f"[batch] Read '{args.project}' — {len(current)} bytes of SVG.")

            for op, elem, payload in EDITS:
                before = current
                current = apply_one(current, op, elem, payload)
                changed = current != before
                label = "applied" if changed else "no-op"
                print(f"  {op}:{elem} {payload}  → {label}")

            api.put_current(args.project, current)
            print(f"[batch] Wrote {len(current)} bytes back to '{args.project}'.")
            return 0

    except (httpx.HTTPError, ConnectionError, OSError) as exc:
        print(f"[batch] Transport error: {exc}", file=sys.stderr)
        return 2
    except MarkupError as exc:
        print(f"[batch] Edit error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
