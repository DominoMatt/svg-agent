"""Smoke tests for the embedded LLM backend (Phase 0 Gate 0).

These tests exercise the REAL model if present. If the model hasn't been
downloaded yet, they skip gracefully so CI stays green without shipping a
450MB binary.
"""

import os
from pathlib import Path

import pytest

from svg_agent.llm_backend import EmbeddedLLM, create_embedded_llm

PROJECT_ROOT = Path(__file__).parent.parent.resolve()

DEFAULT_MODEL = PROJECT_ROOT / "models" / "MiniCPM5-1B-Q4_K_M.gguf"


def _has_a_model() -> bool:
    env_model = os.environ.get("SVG_MODEL_PATH")
    if env_model and Path(env_model).is_file():
        return True
    return DEFAULT_MODEL.is_file()


needs_model = pytest.mark.skipif(
    not _has_a_model(),
    reason="GGUF model not present; place it in models/ or set SVG_MODEL_PATH.",
)


def _greeting() -> str:
    """Plain user utterance; the model's chat template supplies formatting."""
    return "Say hi in one short sentence."


def test_conventional_default_points_at_a_gguf():
    assert DEFAULT_MODEL.name.endswith(".gguf")


@needs_model
def test_complete_produces_non_empty_response():
    with create_embedded_llm(n_ctx=1280) as llm:
        reply = llm.complete(_greeting(), max_tokens=80).strip()
        assert isinstance(reply, str)
        assert len(reply) > 0


@needs_model
def test_stream_yields_token_chunks():
    collected = []
    with create_embedded_llm(n_ctx=896) as llm:
        for token in llm.stream(_greeting(), max_tokens=160):
            collected.append(token)
    joined = "".join(collected).strip()
    assert len(collected) > 0
    assert len(joined) > 0


@needs_model
def test_running_twice_stays_alive():
    replies = []
    for _ in range(2):
        with create_embedded_llm(n_ctx=448) as llm:
            replies.append(llm.complete(_greeting(), max_tokens=28).strip())
    assert all(len(r) > 0 for r in replies)


def test_missing_model_raises_file_not_found():
    with pytest.raises(FileNotFoundError):
        EmbeddedLLM("/does/not/exist.gguf")


@pytest.mark.parametrize(
    ("system", "expected_roles"),
    [
        (None, ["user"]),
        ("Be terse.", ["system", "user"]),
    ],
)
def test_messages_for_shapes_openai_payload(system, expected_roles):
    msg = EmbeddedLLM._messages_for("Hi!", system)
    assert [m["role"] for m in msg] == expected_roles
    assert msg[-1] == {"role": "user", "content": "Hi!"}