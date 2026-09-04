"""Tests for the CLI verbs backed by the SVG Studio HTTP client."""

from __future__ import annotations

import io
from contextlib import redirect_stderr, redirect_stdout
from typing import Self
from unittest.mock import patch

from svg_agent import cli

_MINISCENE = '<svg><circle id="sun" cx="40" cy="60"/></svg>'


class ServerFacade:
    """Speaks the HTTPClient dialect in-memory (faithful stand-in)."""

    def __init__(self) -> None:
        self.state = {"bay": _MINISCENE}
        self.options: list = []
        self.revisions = ["rv-001"]

    def __enter__(self) -> Self:
        return self

    def __exit__(self, *_exc) -> bool:
        return False

    def get_focus(self) -> str:
        return "bay"

    def get_current(self, project: str) -> str:
        return self.state[project]

    def put_current(self, project: str, svg: str) -> None:
        self.state[project] = svg

    def propose(self, project: str, options: list) -> list:
        self.options = list(options)
        return options

    def commit(self, project: str, *, label=None, option=None) -> str:
        seq = len(self.revisions) + 1
        rev = f"rv-{seq:03d}"
        self.revisions.append(rev)
        return rev

    def rollback(self, project: str, version_id: str) -> None:
        return None

    def conventions(self) -> str:
        return "# conventions"

    def authoring(self) -> str:
        return "# authoring"


def _run_main(argv, facade):
    out, err = io.StringIO(), io.StringIO()
    with patch.object(cli, "HTTPClient", return_value=facade), \
         redirect_stdout(out), redirect_stderr(err):
        rc = cli.main(argv)
    return rc, out.getvalue().rstrip()


class TestCmdPropose:
    def test_subjective_instruction_populates_option_tray(self):
        facade = ServerFacade()
        rc, msg = _run_main(["propose", "bay", "make the tide calm"], facade)
        assert rc == cli.RC_OK
        assert "[subjective]" in msg
        assert "Posted 3 option(s)" in msg
        assert [o["label"] for o in facade.options] == [
            "baseline", "emphasis", "understated",
        ]
        # subjective proposes must not mutate the canvas outright
        assert facade.state["bay"] == _MINISCENE

    def test_connection_error_becomes_env_return_code(self):
        import httpx

        faulty = ServerFacade()
        # emulate a transport fault surfacing as httpx.HTTPError family
        faulty.get_current = lambda p: (_ for _ in ()).throw(
            httpx.ConnectError("conn refused")
        )
        rc, _msg = _run_main(["propose", "bay", "whatever"], faulty)
        assert rc == cli.RC_ENVIRONMENT


class TestCmdCommit:
    def test_freezes_version_and_reports_it(self):
        facade = ServerFacade()
        rc, msg = _run_main(["commit", "bay", "--label", "golden"], facade)
        assert rc == cli.RC_OK
        assert "rv-002" in msg
        assert facade.revisions == ["rv-001", "rv-002"]


class TestCmdRollback:
    def test_issues_restoration_confirmation(self):
        facade = ServerFacade()
        rc, msg = _run_main(["rollback", "bay", "rv-002"], facade)
        assert rc == cli.RC_OK
        assert "rolled" in msg.lower()
        assert "rv-002" in msg
