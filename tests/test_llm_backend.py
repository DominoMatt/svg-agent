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

DEFAULT_MODEL = PROJECT_ROOT / "models" / "qwen2.5-0.5b-instruct-q4_k_m.gguf"


def _greeting() -> str:
    """Return a Qwen2.5 chat-template prompt asking for a greeting."""
    return (
        "<|im_start|>user\nSay hi in one short sentence.<|im_end|>\n"
        "<|im_start|>assistant\n"
    )


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