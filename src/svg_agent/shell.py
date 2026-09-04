"""Interactive shell (M4) — a REPL over the workflow controller.

Turnkey ergonomics:
    * Free-form instructions route through ``WorkflowController.run``.
    * Measurable (OBVIOUS) edits preview a diff and seek confirmation
      before hitting ``PUT /current``.
    * Metacommands (leading ':') manage the session: switching projects,
      inspecting the canvas, quitting.
    * Tab-completion offers verbs, metacommands, and element ids harvested
      from the live SVG.
    * A background thread relays SSE events from ``/api/events`` so the
      operator notices concurrent activity without polling.

Pure-stdlib: relies on ``readline`` (POSIX) for history/edit affordances,
falls back to plain ``input`` where unavailable.
"""

from __future__ import annotations

import os
import re
import sys
import threading
from collections import deque
from collections.abc import Iterable
from itertools import zip_longest
from typing import TextIO

from svg_agent.markup import describe_elements
from svg_agent.workflow import IntentKind, WorkflowController

_ID_INNER = re.compile(r'\bid\s*=\s*["\']([^"\']+)["\']')

_BUILTINS = (
    "chat", "edit", "propose", "commit", "rollback", "undo", "shell",
)
_COMMANDS = (
    ":help", ":quit", ":project", ":peek", ":elements", ":clear-history",
)

_NO_COLOR = os.environ.get("NO_COLOR") is not None


def _colour_enabled(stream: TextIO) -> bool:
    return (not _NO_COLOR) and bool(getattr(stream, "isatty", lambda: False)())


_ROLES = {
    "dim": "2",
    "error": "31",
    "notice": "36",
    "ok": "32",
    "warning": "33",
    "heading": "1",
}


def paint(message: str, role: str, stream: TextIO | None = None) -> str:
    """Optionally tint ``message`` with an ANSI role colour."""
    code = _ROLES.get(role)
    if code is None or not _colour_enabled(stream or sys.stdout):
        return message
    return f"\x1b[{code}m{message}\x1b[0m"


def element_ids(source: str) -> list[str]:
    """Collect ``id`` attribute values occurring in the SVG markup."""
    found: list[str] = []
    for info in describe_elements(source):
        interior = source[info.open_start : info.open_end]
        match_obj = _ID_INNER.search(interior)
        if match_obj is not None:
            found.append(match_obj.group(1))
    return found


def build_diff(before: str, after: str, *, context: int = 2) -> str:
    """Compactly highlight changed lines between two SVG snapshots."""
    lhs = before.splitlines()
    rhs = after.splitlines()
    rows = list(zip_longest(lhs, rhs, fillvalue=""))
    interesting = [
        idx for idx, (lo, ro) in enumerate(rows)
        if lo != ro
    ]
    if not interesting:
        return ""
    lo_idx, hi_idx = interesting[0], interesting[-1]
    lo_idx = max(lo_idx - context, 0)
    hi_idx = min(hi_idx + context, len(rows) - 1)
    segments: list[str] = []
    for pos in range(lo_idx, hi_idx + 1):
        old_row, new_row = rows[pos]
        if old_row == new_row:
            segments.append(f"  {old_row}")
        elif new_row == "":
            segments.append(f"- {old_row}")
        elif old_row == "":
            segments.append(f"+ {new_row}")
        else:
            segments.append(f"- {old_row}")
            segments.append(f"+ {new_row}")
    return "\n".join(segments)


class Shell:
    """Owns the REPL session: prompt loop, dispatch, relay, completion."""

    HISTORY_FILE = os.path.expanduser("~/.svg-agent_history")

    def __init__(
        self,
        controller: WorkflowController,
        *,
        project: str | None = None,
        confirm=lambda prompt: input(prompt).strip().lower() in {"y", "yes"},
        sink: TextIO | None = None,
        source: Iterable[str] | None = None,
    ) -> None:
        self.controller = controller
        self.active_project = project
        self.confirm = confirm
        self.out = sink or sys.stdout
        self.source = source
        self.relay_queue: deque = deque(maxlen=16)
        self._relay_event = threading.Event()
        self._relay_thread: threading.Thread | None = None

    # ------------------------- presentation -------------------------- #

    def println(self, message: str = "", role: str | None = None) -> None:
        text = paint(message, role, self.out) if role else message
        print(text, file=self.out)

    def banner(self) -> None:
        self.println("svg-agent shell — type an instruction, or :help", "heading")
        proj = self._effective_project()
        self.println(f"active project: {proj}", "notice")

    # ---------------------------- project ----------------------------- #

    def _effective_project(self) -> str:
        if self.active_project is not None:
            return self.active_project
        return self.controller.resolve_project(None)

    def _fresh_source(self) -> str:
        return self.controller.client.get_current(self._effective_project())

    # ------------------------ instruction flow ----------------------- #

    def _handle_instruction(self, instruction: str) -> None:
        project = self._effective_project()
        current = self.controller.client.get_current(project)
        kind = self.controller.classifier(instruction)

        if kind is IntentKind.OBVIOUS:
            revised = self.controller.apply_direct(current, instruction)
            preview = build_diff(current, revised)
            if preview:
                self.println("change preview:", "heading")
                self.println(preview, "dim")
            if self.confirm("apply this edit? [y/N] "):
                self.controller.client.put_current(project, revised)
                self.println(f"saved to '{project}'.", "ok")
            else:
                self.println("discarded.", "warning")
            return

        variants = self.controller.make_variants(instruction, current)
        posted = self.controller.client.propose(project, variants)
        labels = [item.get("label", "?") for item in posted]
        self.println(
            f"[{kind.value}] posted {len(labels)} option(s): {', '.join(labels)}.",
            "notice",
        )

    # --------------------------- metacommands ------------------------- #

    def _dispatch(self, line: str) -> bool:
        """Handle one line; return False to halt the loop."""
        trimmed = line.strip()
        if not trimmed:
            return True
        if trimmed.startswith(":"):
            return self._metacmd(trimmed)
        self._handle_instruction(trimmed)
        return True

    def _metacmd(self, line: str) -> bool:
        head, _, rest = line.partition(" ")
        if head == ":quit":
            return False
        if head == ":help":
            self._print_help()
            return True
        if head == ":project":
            name = rest.strip()
            if not name:
                self.println("usage: :project NAME", "warning")
                return True
            self.active_project = name
            self.println(f"active project -> {name}", "notice")
            return True
        if head == ":peek":
            self.println(self._fresh_source(), "dim")
            return True
        if head == ":elements":
            ids = element_ids(self._fresh_source())
            self.println(", ".join(ids) if ids else "(no ids found)", "notice")
            return True
        if head == ":clear-history":
            self.clear_history()
            self.println("history cleared.", "notice")
            return True
        self.println(f"unknown command: {head} (try :help)", "error")
        return True

    def _print_help(self) -> None:
        self.println(
            "instructions route through the workflow controller;\n"
            "measurable edits preview a diff before saving.\n"
            "metacommands:\n"
            "  :project NAME   switch the active project\n"
            "  :peek           print the current SVG\n"
            "  :elements       list element ids in the current SVG\n"
            "  :clear-history  wipe the readline history\n"
            "  :quit           leave the shell",
            "notice",
        )

    # ------------------------------ history --------------------------- #

    def load_history(self) -> None:
        try:
            import readline

            hist = self.HISTORY_FILE
            if os.path.exists(hist):
                readline.read_history_file(hist)
        except (ImportError, OSError):
            pass

    def save_history(self) -> None:
        try:
            import readline

            readline.write_history_file(self.HISTORY_FILE)
        except (ImportError, OSError):
            pass

    def clear_history(self) -> None:
        try:
            import readline

            readline.clear_history()
        except (ImportError, OSError):
            pass

    # ------------------------------- SSE ------------------------------ #

    def start_relay(self) -> None:
        if self._relay_thread is not None:
            return
        self._relay_event.clear()
        worker = threading.Thread(
            target=self._poll_events, name="svg-events-relay", daemon=True
        )
        self._relay_thread = worker
        worker.start()

    def _poll_events(self) -> None:
        try:
            for event in self.controller.client.events():
                self.relay_queue.append(event)
                self._relay_event.set()
        except Exception:  # noqa: BLE001 - relay must never die loudly
            return

    def drain_relay(self) -> None:
        while self.relay_queue:
            event = self.relay_queue.popleft()
            stamp = event.get("type", event.get("kind", "event"))
            self.println(f"[live:{stamp}] {event}", "dim")

    def stop_relay(self) -> None:
        if self._relay_thread is None:
            return
        self._relay_event.set()
        self._relay_thread.join(timeout=1.0)
        self._relay_thread = None

    # -------------------------------- loop ---------------------------- #

    def run(self) -> int:
        self.banner()
        self.load_history()
        self.start_relay()
        try:
            if self.source is not None:
                for line in self.source:
                    self.drain_relay()
                    if not self._dispatch(line):
                        break
            else:
                while True:
                    self.drain_relay()
                    try:
                        line = input("svg> ")
                    except EOFError:
                        break
                    if not self._dispatch(line):
                        break
        finally:
            self.stop_relay()
            self.save_history()
        self.println("bye.", "dim")
        return 0