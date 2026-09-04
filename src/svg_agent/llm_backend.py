"""LLM Backend — Embedded implementation using llama-cpp-python."""

from __future__ import annotations

import os
from contextlib import contextmanager
from pathlib import Path
from typing import Generator, Optional

from llama_cpp import Llama


class EmbeddedLLM:
    """
    In-process LLM wrapper around llama-cpp-python.

    Loads a GGUF model into the current process and provides
    streaming completion. Designed for small models (<1B params, q4 quant).
    """

    def __init__(
        self,
        model_path: str | Path,
        *,
        n_ctx: int = 2048,
        n_threads: int = 4,
        n_gpu_layers: int = 0,
        verbose: bool = False,
    ) -> None:
        """
        Initialize the embedded LLM.

        Args:
            model_path: Path to the GGUF model file.
            n_ctx: Context window size (tokens).
            n_threads: CPU threads for inference.
            n_gpu_layers: Number of layers to offload to GPU (0 = CPU only).
            verbose: Enable llama.cpp debug logs.
        """
        self.model_path = Path(model_path).expanduser().resolve()
        if not self.model_path.exists():
            raise FileNotFoundError(f"Model not found: {self.model_path}")

        self._llm = Llama(
            model_path=str(self.model_path),
            n_ctx=n_ctx,
            n_threads=n_threads,
            n_gpu_layers=n_gpu_layers,
            verbose=verbose,
        )

    def complete(
        self,
        prompt: str,
        *,
        max_tokens: int = 640,
        temperature: float = 0.1,
        stop: Optional[list[str]] = None,
    ) -> str:
        """
        Generate a completion (non-streaming).

        Delegates to ``create_chat_completion`` so the model's own embedded
        chat template controls formatting (robust across architectures).
        ``prompt`` is treated as the user utterance.

        Returns the full generated text.
        """
        kwargs = {}
        if stop is not None:
            kwargs["stop"] = stop
        out = self._llm.create_chat_completion(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            temperature=temperature,
            stream=False,
            **kwargs,
        )
        return out["choices"][0]["message"]["content"]

    def stream(
        self,
        prompt: str,
        *,
        max_tokens: int = 512,
        temperature: float = 0.1,
        stop: Optional[list[str]] = None,
    ) -> Generator[str, None, None]:
        """
        Stream a completion token-by-token.

        Like ``complete``, delegates to ``create_chat_completion`` so the
        model's own embedded chat template governs formatting. ``prompt`` is
        treated as the user utterance.

        Yields each token as it's generated.
        """
        kwargs = {}
        if stop is not None:
            kwargs["stop"] = stop
        for chunk in self._llm.create_chat_completion(
            messages=[{"role": "user", "content": prompt}],
            max_tokens=max_tokens,
            temperature=temperature,
            stream=True,
            **kwargs,
        ):
            delta = chunk["choices"][0].get("delta", {})
            token = delta.get("content", "")
            if token:
                yield token

    def __enter__(self) -> EmbeddedLLM:
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        # llama-cpp-python doesn't have explicit cleanup, but we can
        # delete the reference to help GC
        del self._llm


@contextmanager
def create_embedded_llm(
    model_path: Optional[str | Path] = None,
    **kwargs,
) -> Generator[EmbeddedLLM, None, None]:
    """
    Context manager factory for EmbeddedLLM.

    Reads model path from:
    1. Explicit `model_path` argument
    2. `SVG_MODEL_PATH` environment variable
    3. Default: `models/MiniCPM5-1B-Q4_K_M.gguf`

    Usage:
        with create_embedded_llm() as llm:
            for tok in llm.stream("Hello!"):
                print(tok, end="", flush=True)
    """
    if model_path is None:
        model_path = os.getenv(
            "SVG_MODEL_PATH",
            "models/MiniCPM5-1B-Q4_K_M.gguf",
        )

    llm = EmbeddedLLM(model_path, **kwargs)
    try:
        yield llm
    finally:
        # Explicit cleanup hint
        del llm