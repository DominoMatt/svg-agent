"""Hermetic unit tests for HTTPClient using MockTransport (no live server)."""

import json

import httpx
import pytest

from svg_agent.client import HTTPClient


def _router(capture: list) -> httpx.Response:
    def router(request: httpx.Request) -> httpx.Response:
        capture.append(request)
        path = request.url.path
        method = request.method
        if path == "/api" and method == "GET":
            return httpx.Response(200, json={"endpoints": ["/api/conventions"]})
        if path == "/api/conventions" and method == "GET":
            return httpx.Response(200, text="# Rules")
        if path == "/api/focus" and method == "GET":
            return httpx.Response(200, json={"project": "fish"})
        if path == "/api/focus" and method == "PUT":
            return httpx.Response(200, json={"project": "octopus"})
        if path.endswith("/current") and method == "GET":
            return httpx.Response(200, text="<svg></svg>")
        if path.endswith("/current") and method == "PUT":
            return httpx.Response(200, json={"ok": True})
        if path.endswith("/options") and method == "GET":
            return httpx.Response(200, json=[{"id": "opt-A"}])
        if path.endswith("/options") and method == "POST":
            return httpx.Response(200, json={"created": [{"id": "opt-X"}]})
        if path.endswith("/select") and method == "POST":
            return httpx.Response(200, json={"ok": True})
        if path.endswith("/commit") and method == "POST":
            return httpx.Response(200, json={"id": "v007-final"})
        if path.endswith("/versions") and method == "GET":
            return httpx.Response(200, json=[{"id": "v006-old"}])
        if "/rollback/" in path and method == "POST":
            return httpx.Response(200, json={"ok": True})
        if path.endswith("/undo") and method == "POST":
            return httpx.Response(200, json={"ok": True, "undone": True})
        return httpx.Response(404, text="miss")

    return router


@pytest.fixture()
def capture() -> list:
    return []


@pytest.fixture()
def api(capture: list) -> HTTPClient:
    transport = httpx.MockTransport(_router(capture))
    return HTTPClient("http://studio.local", transport=transport)


def test_discovery_hits_root(api, capture):
    assert api.discovery() == {"endpoints": ["/api/conventions"]}
    req = capture.pop()
    assert req.method == "GET"
    assert req.url.path == "/api"


def test_conventions_returned_as_markdown(api, capture):
    assert "# Rules" in api.conventions()
    assert capture.pop().url.path == "/api/conventions"


def test_focus_read_then_write(api, capture):
    assert api.get_focus() == "fish"
    assert api.set_focus("octopus") == "octopus"
    put_req = capture.pop()
    assert put_req.method == "PUT"
    assert json.loads(put_req.content.decode()).get("project") == "octopus"


def test_project_names_encode_spaces_but_split_slashes(api, capture):
    api.put_current("two words/x", "<svg/>")
    req = capture.pop()
    # Spaces are percent-encoded; '/' separates path segments (not encoded).
    assert "two%20words/x" in str(req.url)


def test_put_current_envelopes_svg_field(api, capture):
    api.put_current("fish", "<svg id=x/>")
    req = capture.pop()
    assert json.loads(req.content.decode()) == {"svg": "<svg id=x/>"}
    assert req.headers["content-type"].startswith("application/json")


def test_select_and_commit_shape(api, capture):
    api.select("fish", "opt-A")
    sel = capture.pop()
    assert json.loads(sel.content.decode()) == {"option": "opt-A"}
    vid = api.commit("fish", label="final")
    com = capture.pop()
    assert vid == "v007-final"
    assert json.loads(com.content.decode()) == {"label": "final"}


def test_undeclared_route_surfaces_http_error(api):
    with pytest.raises(httpx.HTTPStatusError):
        api._req_raw("GET", f"{api.base_url}/api/nope")
