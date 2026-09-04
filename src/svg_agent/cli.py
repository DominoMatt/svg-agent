"""Command-line entrypoint for svg-agent.

Phase 0 (M0) delivers the embedded-LLM backbone. Of the planned verbs, only
``chat`` is functional today — it streams a reply from the in-process model.
Everything else maps to later milestones and prints an honest placeholder.

Planned mapping (see PLAN.md):
    edit/propose/commit/rollback/undo  -> M1-M2 (core client + workflow)
    shell                              -> M4 (interactive REPL)
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - dotenv is optional sugar
    def load_dotenv(**_) -> None:
        """No-op fallback when python-dotenv is not installed."""

from svg_agent.llm_backend import create_embedded_llm

_VERSION = "%(prog)s 0.1.0"

_NOT_YET = "{verb}: scheduled for {when}; not implemented in Phase 0 (M0)."


def cmd_chat(args: argparse.Namespace) -> int:
    """Stream a reply from the embedded model (functional in M0)."""
    system = args.system or (
        "You are a minimalist CLI companion. Reply tersely\u2014one short "
        "sentence, no preamble, no emoji."
    )
    print("[svg-agent] Loading model...", file=sys.stderr)
    try:
        with create_embedded_llm() as llm:
            print("[svg-agent] Ready. Streaming:", file=sys.stderr)
            for token in llm.stream(system=system, prompt=args.prompt, max_tokens=args.max_tokens):
                print(token, end="", flush=True)
    except FileNotFoundError as err:
        print(f"[svg-agent] ERROR: {err}", file=sys.stderr)
        print(
            "[svg-agent] Place a GGUF in models/ or export SVG_MODEL_PATH.",
            file=sys.stderr,
        )
        return 1
    print(file=sys.stdout)
    return 0


def _placeholder(name: str, milestone: str) -> None:
    print(_NOT_YET.format(verb=f"{name:<8}", when=milestone))


def cmd_edit(args: argparse.Namespace) -> int:
    _placeholder("edit", "M1 (core client)")
    return 99


def cmd_propose(args: argparse.Namespace) -> int:
    _placeholder("propose", "M2 (workflow controller)")
    return 98


def cmd_commit(args: argparse.Namespace) -> int:
    _placeholder("commit", "M2 (workflow controller)")
    return 96


def cmd_rollback(args: argparse.Namespace) -> int:
    _placeholder("rollback", "M2 (workflow controller)")
    return 94


def cmd_undo(args: argparse.Namespace) -> int:
    _placeholder("undo", "M2 (workflow controller)")
    return 92


def cmd_shell(args: argparse.Namespace) -> int:
    _placeholder("shell", "M4 (interactive REPL)")
    return 88


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="svg-agent",
        description="Lightweight SVG Studio Agent (embed-a-small-LLM edition).",
    )
    parser.add_argument("-V", "--version", action="version", version=_VERSION)
    sub = parser.add_subparsers(dest="cmd", metavar="{chat,edit,...}")

    p_chat = sub.add_parser("chat", help="stream a reply from the embedded model")
    p_chat.add_argument("prompt", help="utterance to send to the model")
    p_chat.add_argument("-m", "--max-tokens", type=int, default=48, dest="max_tokens")
    p_chat.add_argument("--system", default=None, help="override the system directive")
    p_chat.set_defaults(func=cmd_chat)

    p_edit = sub.add_parser("edit", help="apply a direct edit (planned M1)")
    p_edit.add_argument("project"); p_edit.add_argument("instruction")
    p_edit.set_defaults(func=cmd_edit)

    p_pr = sub.add_parser("propose", help="generate variants (planned M2)")
    p_pr.add_argument("project"); p_pr.add_argument("instruction")
    p_pr.add_argument("--count", type=int, default=3)
    p_pr.set_defaults(func=cmd_propose)

    p_co = sub.add_parser("commit", help="save a labelled version (planned M2)")
    p_co.add_argument("project"); p_co.add_argument("--label", default=None)
    p_co.set_defaults(func=cmd_commit)

    p_rb = sub.add_parser("rollback", help="restore a prior version (planned M2)")
    p_rb.add_argument("project"); p_rb.add_argument("ref")
    p_rb.set_defaults(func=cmd_rollback)

    p_un = sub.add_parser("undo", help="discard latest change (planned M2)")
    p_un.add_argument("project")
    p_un.set_defaults(func=cmd_undo)

    p_sh = sub.add_parser("shell", help="interactive REPL (planned M4)")
    p_sh.set_defaults(func=cmd_shell)

    return parser


def dispatch(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    ns = parser.parse_args(None if argv is None else list(argv))
    if not getattr(ns, "func", None):
        parser.print_usage(sys.stderr)
        return 107
    return ns.func(ns)


def main(argv: Sequence[str] | None = None) -> int:
    load_dotenv()
    return dispatch(argv)


if __name__ == "__main__":
    raise SystemExit(main())
