"""Tests for the M4 interactive shell and its pure helpers."""

from __future__ import annotations

import io
from typing import Self

from svg_agent.shell import Shell, build_diff, element_ids, paint
from svg_agent.workflow import WorkflowController

# ------------------------------------------------------------------ #
# Fake server facade (subset of what the shell actually touches)      #
# ------------------------------------------------------------------ #

_MINI = (
    '<svg xmlns="http://www.w3.org/2000/svg">'
    '<circle id="sun" cx="40" cy="60"/>'
    '<rect id="box" x="10" y="20"/>'
    '</svg>'
)


class FakeServer:
    def __init__(self) -> None:
        self.state: dict[str, str] = {"bay": _MINI}
        self.options: list = []
        self.undone = False

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_a) -> bool:
        return False

    def get_focus(self) -> str:
        return "bay"

    def get_current(self, p: str) -> str:
        return self.state[p]

    def put_current(self, p: str, svg: str) -> None:
        self.state[p] = svg

    def propose(self, p: str, opts: list) -> list:
        self.options = list(opts)
        return opts

    def conventions(self) -> str:
        return "# conv"

    def authoring(self) -> str:
        return "# auth"

    def events(self):
        return iter([])


def _make_controller(project="bay"):
    return WorkflowController(FakeServer())


# ------------------------------------------------------------------ #
# paint                                                               #
# ------------------------------------------------------------------ #


class TestPaint:
    def test_no_color_when_stream_is_not_tty(self):
        buf = io.StringIO()
        result = paint("hello", "ok", buf)
        assert result == "hello"

    def test_role_unknown_returns_plain(self):
        buf = io.StringIO()
        result = paint("hello", "bogus", buf)
        assert result == "hello"


# ------------------------------------------------------------------ #
# element_ids                                                         #
# ------------------------------------------------------------------ #


class TestElementIds:
    def test_extracts_ids_in_document_order(self):
        assert element_ids(_MINI) == ["sun", "box"]

    def test_empty_svg_yields_empty_list(self):
        assert element_ids("<svg></svg>") == []


# ------------------------------------------------------------------ #
# build_diff                                                          #
# ------------------------------------------------------------------ #


class TestBuildDiff:
    def test_identical_returns_empty(self):
        assert build_diff("abc", "abc") == ""

    def test_changed_lines_appear(self):
        diff = build_diff("line1\nline2", "line1\nLINE2")
        assert "- line2" in diff
        assert "+ LINE2" in diff


# ------------------------------------------------------------------ #
# Shell loop — metacommands                                          #
# ------------------------------------------------------------------ #


class TestShellMetacommands:
    def test_quit_exits(self):
        ctrl = _make_controller()
        sh = Shell(ctrl, source=[":quit"])
        rc = sh.run()
        assert rc == 0

    def test_project_switches(self, capsys=None):
        ctrl = _make_controller()
        sh = Shell(ctrl, source=[":project atlas", ":quit"])
        sh.run()
        assert sh.active_project == "atlas"

    def test_elements_lists_ids(self):
        ctrl = _make_controller()
        out = io.StringIO()
        sh = Shell(ctrl, source=[":elements", ":quit"], sink=out)
        sh.run()
        assert "sun" in out.getvalue()
        assert "box" in out.getvalue()

    def test_peek_prints_svg(self):
        ctrl = _make_controller()
        out = io.StringIO()
        sh = Shell(ctrl, source=[":peek", ":quit"], sink=out)
        sh.run()
        assert "circle" in out.getvalue()

    def test_unknown_command_reports_error(self):
        ctrl = _make_controller()
        out = io.StringIO()
        sh = Shell(ctrl, source=[":bogus", ":quit"], sink=out)
        sh.run()
        assert "unknown command" in out.getvalue().lower()


# ------------------------------------------------------------------ #
# Shell loop — instruction dispatch                                  #
# ------------------------------------------------------------------ #


class TestShellInstructions:
    def test_obvious_confirmed_saves(self):
        ctrl = _make_controller()
        fac = ctrl.client
        out = io.StringIO()
        sh = Shell(
            ctrl,
            source=["sun right 10px", ":quit"],
            confirm=lambda _: True,
            sink=out,
        )
        sh.run()
        assert "translate(10,0)" in fac.state["bay"]

    def test_obvious_rejected_discards(self):
        ctrl = _make_controller()
        fac = ctrl.client
        before = fac.state["bay"]
        sh = Shell(
            ctrl,
            source=["sun right 10px", ":quit"],
            confirm=lambda _: False,
        )
        sh.run()
        assert fac.state["bay"] == before

    def test_subjective_posts_variants(self):
        ctrl = _make_controller()
        fac = ctrl.client
        out = io.StringIO()
        sh = Shell(
            ctrl,
            source=["make the water dreamier", ":quit"],
            sink=out,
        )
        sh.run()
        labels = [o["label"] for o in fac.options]
        assert labels == ["baseline", "emphasis", "understated"]


# ------------------------------------------------------------------ #
# Shell loop — blank lines / empty input                             #
# ------------------------------------------------------------------ #


class TestShellEdgeCases:
    def test_blank_lines_are_harmless(self):
        ctrl = _make_controller()
        sh = Shell(ctrl, source=["", "  ", ":quit"])
        rc = sh.run()
        assert rc == 0
