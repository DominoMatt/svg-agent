"""ConventionStore — fetched-and-cached workflow guides.

Thin adapter over the studio server's informational endpoints. Guides are
expensive-ish to transfer and effectively static per session, so they are
fetched lazily once and memoised afterwards (mirrors the PLAN's
"load context once per session" step).

Provides:
    conventions()  -> BROWSER_AGENTS.md markdown
    authoring()    -> AUTHORING.md markdown
    reload()       -> bust the cache and refetch
"""

from __future__ import annotations

from functools import partial

from svg_agent.client import HTTPClient


class ConventionStore:
    """Memoised reader for the server-provided workflow guides."""

    def __init__(self, client: HTTPClient) -> None:
        self._client = client
        self._guides: dict[str, str | None] = {"conventions": None, "authoring": None}

    def conventions(self) -> str:
        return self._guide("conventions")

    def authoring(self) -> str:
        return self._guide("authoring")

    def _guide(self, key: str) -> str:
        cached = self._guides[key]
        if cached is not None:
            return cached
        fetch = partial(getattr(self._client, key))
        text = fetch()
        self._guides[key] = text
        return text

    def reload(self) -> None:
        """Invalidate cached guides so the next read refetches."""
        self._guides.update({k: None for k in self._guides})
