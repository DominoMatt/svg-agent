#!/usr/bin/env python3
"""Variant proposal — post a palette of alternatives to the option tray.

Demonstrates the propose → select → commit workflow.  The agent proposes
three variant labels ("baseline", "emphasis", "understated"), the human
picks one in the browser, and then this script (or a follow-up) commits it.

Usage:
    python examples/variant_proposal.py [PROJECT] [--server URL] [--instruction TEXT]

Requires a running SVG Studio server on the given URL (default :3000).
"""

from __future__ import annotations

import argparse
import sys

import httpx

from svg_agent.client import HTTPClient
from svg_agent.workflow import WorkflowController


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("project", nargs="?", default="fish", help="project name (default: fish)")
    ap.add_argument("--server", default="http://localhost:3000", help="SVG Studio base URL")
    ap.add_argument(
        "-i", "--instruction", default="friendlier expression",
        help="natural-language instruction for the workflow controller",
    )
    args = ap.parse_args()

    try:
        with HTTPClient(args.server) as api:
            controller = WorkflowController(api)

            # ── Propose ───────────────────────────────────────────────
            verdict = controller.run(args.instruction, args.project)
            print(f"[propose] {verdict.summary}")
            print("[propose] Open the SVG Studio browser to pick a favourite.")

            # ── List what's in the tray ───────────────────────────────
            options = api.list_options(args.project)
            if options:
                print(f"[propose] Option tray now has {len(options)} item(s):")
                for opt in options:
                    oid = opt.get("id", "?")
                    label = opt.get("label", "")
                    committed = "committed" if opt.get("committed") else "pending"
                    print(f"  • {oid}  ({label})  [{committed}]")
            else:
                print("[propose] Tray is empty — the instruction may have been direct (OBVIOUS).")

            return 0

    except (httpx.HTTPError, ConnectionError, OSError) as exc:
        print(f"[propose] Transport error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
