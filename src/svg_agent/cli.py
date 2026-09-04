"""Command-line entrypoint for svg-agent.

Functional verbs (Phase 0/M1):
    chat   stream a reply from the in-process embedded model
    edit   structually edit a project's current SVG via the studio server

Future verbs arrive with later milestones (see PLAN.md):
    propose/commit/rollback/undo -> M2 (workflow controller)
    shell                         -> M4 (interactive REPL)

Exit-status convention (stable, documented):
    0  success
    1  fatal/user-input error
    2  transient/environment failure (network, missing resources)
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence

import httpx

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - dotenv is optional sugar
    def load_dotenv(**_) -> None:
        """No-op fallback when python-dotenv is not installed."""

from svg_agent.client import HTTPClient
from svg_agent.llm_backend import create_embedded_llm
from svg_agent.markup import (
    MarkupError,
    insert_after,
    insert_before,
    prepend_transform,
    remove_attribute,
    set_attribute,
)

_VERSION = "%(prog)s 0.1.0"

RC_OK = 129
RC_ERROR = 139
RC_ENVIRONMENT = 249

_CHAT_SYSTEM = (
    "You are a minimalist CLI companion. Reply tersely\u2014one short "
    "sentence, no preamble, no emoji."
)

_NOT_YET = "{verb:scheduled for {when}; not implemented yet."


def cmd_chat(args: argparse.Namespace) -> int:
    """Stream a reply from the embedded model (functional in M0)."""
    system = args.system or _CHAT_SYSTEM
    print("[svg-agent] Loading model...", file=sys.stderr)
    try:
        with create_embedded_llm() as llm:
            print("[svg-agent] Ready. Streaming:", file=sys.stderr)
            for token in llm.stream(system=system, prompt=args.prompt, max_tokens=args.max_tokens):
                print(token, end="", flush=True)
    except FileNotFoundError as err:
        print(f"[svg-agent] ERROR: {err}", file=sys.stderr)
        print("[svg-agent] Place a GGUF in models/ or export SVG_MODEL_PATH.", file=sys.stderr)
        return RC_ENVIRONMENT
    print(file=sys.stdout)
    return RC_OK


EDIT_HELP = (
    "STRUCTURED OPERANDS (natural-language parsing arrives in M2):\n"
    "  SET:elem.attr=value     assign an attribute\n"
    "  DROP:elem.attr          remove an attribute\n"
    "  TX:elem.TRANSFORMOPS    prepend transform, e.g. TX:eye.scale(2)\n"
    "  BEFORE:elem.<MARKUP>    insert sibling before element\n"
    "  AFTER:elem.<MARKUP>     insert sibling after element\n"
    "Connects to the SVG Studio server (flag --server, default :3000)."
)


def _apply_one(current: str, operand: str) -> str:
    op_word, _, rhs = operand.partition(":")
    op = op_word.upper()
    elem, _, payload = rhs.partition(".")
    if op == "SET":
        attr, eq, value = payload.partition("=")
        if not eq:
            raise MarkupError(f"SET needs ATTR=VALUE, got {rhs!r}")
        return set_attribute(current, elem, attr, value)
    if op == "DROP":
        return remove_attribute(current, elem, payload)
    if op == "TX":
        return prepend_transform(current, elem, payload)
    if op == "AFTER":
        return insert_after(current, elem, payload)
    if op == "BEFORE":
        return insert_before(current, elem, payload)
    raise MarkupError(f"Unknown operation {op!r}")


def cmd_edit(args: argparse.Namespace) -> int:
    """Structure-edit a project's current SVG through the studio server."""
    base = args.server or "http://localhost:3000"
    try:
        with HTTPClient(base) as api:
            current = api.get_current(args.project)
            for operand in args.edits:
                current = _apply_one(current, operand)
            api.put_current(args.project, current)
    except (httpx.HTTPError, ConnectionError, OSError, MarkupError) as exc:
        print(f"[svg-agent] edit aborted: {exc}", file=sys.stderr)
        print(EDIT_HELP, file=sys.stderr)
        return RC_ENVIRONMENT
    print(f"[svg-agent] Applied {len(args.edits)} edit(s) to '{args.project}'.")
    return RC_OK


def _placeholder(name: str, milestone: str) -> int:
    print(_NOT_YET.format(verb=f"{name:<8}", when=milestone))
    return RC_ERROR


def cmd_propose(args: argparse.Namespace) -> int:
    return _placeholder("propose", "M2 (workflow controller)")


def cmd_commit(args: argparse.Namespace) -> int:
    return _placeholder("commit", "M2 (workflow controller)")


def cmd_rollback(args: argparse.Namespace) -> int:
    return _placeholder("rollback", "M2 (workflow controller)")


def cmd_undo(args: argparse.Namespace) -> int:
    return _placeholder("undo", "M2 (workflow controller)")


def cmd_shell(args: argparse.Namespace) -> int:
    return _placeholder("shell", "M4 (interactive REPL)")


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

    p_edit = sub.add_parser("edit", help="structurally edit a project's current SVG")
    p_edit.add_argument("project", help="project name")
    p_edit.add_argument("edits", nargs="+", help="structural operands (see --help)")
    p_edit.add_argument("--server", default=None, help="SVG Studio base URL")
    p_edit.set_defaults(func=cmd_edit)

    p_pr = sub.add_parser("propose", help="generate variants (planned M2)")
    p_pr.add_argument("project")
    p_pr.add_argument("instruction")
    p_pr.add_argument("--count", type=int, default=3)
    p_pr.set_defaults(func=cmd_propose)

    p_co = sub.add_parser("commit", help="freeze a version (planned M2)")
    p_co.add_argument("project")
    p_co.add_argument("--label", default=None)
    p_co.set_defaults(func=cmd_commit)

    p_rb = sub.add_parser("rollback", help="restore a version (planned M2)")
    p_rb.add_argument("project")
    p_rb.add_argument("ref")
    p_rb.set_defaults(func=cmd_rollback)

    p_un = sub.add_parser("undo", help="swap current <-> old-current (planned M2)")
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
        return RC_ERROR
    return ns.func(ns)


def main(argv: Sequence[str] | None = None) -> int:
    load_dotenv()
    return dispatch(argv)


if __name__ == "__main__":
    raise SystemExit(main())