"""HTTPClient — thin synchronous wrapper over the SVG Studio REST + SSE API.

Every method corresponds to a documented endpoint (see PLAN.md appendix);
requests are shaped exactly per the published contract. An injectable
transport keeps unit tests hermetic (no live server required).

Endpoints covered:
    GET  /api                          discovery catalogue
    GET  /api/conventions              BROWSER_AGENTS.md (markdown)
    GET  /api/authoring                AUTHORING.md (markdown)
    GET  /api/focus                    current project
    PUT  /api/focus                    set current project
    GET  /api/projects/<name>/current  working SVG
    PUT  /api/projects/<name>/current  publish revised SVG
    GET  /api/projects/<name>/options  proposal tray
    POST /api/projects/<name>/options  submit proposals
    POST /api/projects/<name>/select   adopt a proposal
    POST /api/projects/<name>/commit   freeze a version
    GET  /api/projects/<name>/versions history
    POST /api/projects/<name>/rollback/<id> restore a version
    POST /api/projects/<name>/undo     swap current <-> old-current
    GET  /api/events                   SSE stream
"""

from __future__ import annotations

import json
from collections.abc import Iterator, Mapping
from urllib.parse import quote

import httpx

BASE_TIMEOUT_SECONDS = 61.0


class APIContractError(RuntimeError):
    """Response violated the documented contract unexpectedly."""


class HTTPClient:
    """Typed facade over the SVG Studio HTTP surface."""

    def __init__(
        self,
        base_url: str = "http://localhost:3010",
        *,
        timeout: float = BASE_TIMEOUT_SECONDS,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(timeout=timeout, transport=transport)

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> HTTPClient:  # noqa: PYI034 - truthfully returns self
        return self

    def __exit__(self, *exc) -> None:
        self.close()

    # ------------------------------------------------------------------ #
    # Low-level helpers                                                   #
    # ------------------------------------------------------------------ #

    def _req_json(self, method: str, url: str, **payload) -> object:
        res = self._client.request(method, url, json=payload or None)
        res.raise_for_status()
        if not res.content:
            return None
        return res.json()

    def _req_raw(self, method: str, url: str, body: str | None = None) -> str:
        res = self._client.request(method, url, content=body.encode() if body else None)
        res.raise_for_status()
        return res.text

    @staticmethod
    def _pj(parts: str) -> str:
        return "/".join(quote(str(p), safe="") for p in parts.split("/"))

    # ------------------------------------------------------------------ #
    # Catalog                                                             #
    # ------------------------------------------------------------------ #

    def discovery(self) -> object:
        return self._req_json("GET", f"{self.base_url}/api")

    def conventions(self) -> str:
        return self._req_raw("GET", f"{self.base_url}/api/conventions")

    def authoring(self) -> str:
        return self._req_raw("GET", f"{self.base_url}/api/authoring")

    # ------------------------------------------------------------------ #
    # Focus                                                               #
    # ------------------------------------------------------------------ #

    def get_focus(self) -> str:
        obj = self._req_json("GET", f"{self.base_url}/api/focus")
        proj = obj.get("project") if isinstance(obj, Mapping) else None
        if not isinstance(proj, str):
            raise APIContractError(f"Bad focus payload: {obj!r}")
        return proj

    def set_focus(self, project: str) -> str:
        obj = self._req_json("PUT", f"{self.base_url}/api/focus", project=project)
        proj = obj.get("project") if isinstance(obj, Mapping) else None
        if not isinstance(proj, str):
            raise APIContractError(f"Focus echoed improperly: {obj!r}")
        return proj

    # ------------------------------------------------------------------ #
    # Projects                                                            #
    # ------------------------------------------------------------------ #

    def get_current(self, project: str) -> str:
        return self._req_raw("GET", f"{self.base_url}/api/projects/{self._pj(project)}/current")

    def put_current(self, project: str, svg: str) -> None:
        self._req_json(
            "PUT", f"{self.base_url}/api/projects/{self._pj(project)}/current", svg=svg
        )

    def list_options(self, project: str) -> list[Mapping]:
        obj = self._req_json("GET", f"{self.base_url}/api/projects/{self._pj(project)}/options")
        if not isinstance(obj, list):
            raise APIContractError(f"Options not a list: {obj!r}")
        return obj

    def propose(self, project: str, options: list[Mapping]) -> list[Mapping]:
        obj = self._req_json(
            "POST", f"{self.base_url}/api/projects/{self._pj(project)}/options", options=options
        )
        created = obj.get("created") if isinstance(obj, Mapping) else None
        if not isinstance(created, list):
            raise APIContractError(f"Expected created list, got: {obj!r}")
        return created

    def select(self, project: str, option_id: str) -> None:
        self._req_json(
            "POST", f"{self.base_url}/api/projects/{self._pj(project)}/select", option=option_id
        )

    def commit(self, project: str, *, label: str | None = None, option: str | None = None) -> str:
        payload: dict[str, str] = {}
        if label is not None:
            payload["label"] = label
        if option is not None:
            payload["option"] = option
        obj = self._req_json(
            "POST", f"{self.base_url}/api/projects/{self._pj(project)}/commit", **payload
        )
        vid = obj.get("id") if isinstance(obj, Mapping) else None
        if not isinstance(vid, str):
            raise APIContractError(f"Commit lacked id: {obj!r}")
        return vid

    def list_versions(self, project: str) -> list[Mapping]:
        obj = self._req_json("GET", f"{self.base_url}/api/projects/{self._pj(project)}/versions")
        if not isinstance(obj, list):
            raise APIContractError(f"Versions not a list: {obj!r}")
        return obj

    def rollback(self, project: str, version_id: str) -> None:
        self._req_json(
            "POST",
            f"{self.base_url}/api/projects/{self._pj(project)}/rollback/{self._pj(version_id)}",
        )

    def undo(self, project: str) -> bool:
        obj = self._req_json("POST", f"{self.base_url}/api/projects/{self._pj(project)}/undo")
        undone = obj.get("undone") if isinstance(obj, Mapping) else None
        if not isinstance(undone, bool):
            raise APIContractError(f"Undo responded ambiguously: {obj!r}")
        return undone

    # ------------------------------------------------------------------ #
    # Event stream                                                        #
    # ------------------------------------------------------------------ #

    def events(self) -> Iterator[Mapping]:
        """Iterate decoded SSE events from ``/api/events`` (JSON-data assumed)."""
        with self._client.stream("GET", f"{self.base_url}/api/events") as resp:
            resp.raise_for_status()
            for line in resp.iter_lines():
                if not line or not line.startswith("data:"):
                    continue
                datum = line[len("data:") :].strip()
                if not datum:
                    continue
                try:
                    evt = json.loads(datum)
                except json.JSONDecodeError:
                    continue
                if isinstance(evt, Mapping):
                    yield evt
