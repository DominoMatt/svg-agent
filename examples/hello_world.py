#!/usr/bin/env python3
"""
Phase 0 Hello World — Embed an LLM in-process and stream a greeting.

Usage:
    python examples/hello_world.py

Environment:
    SVG_MODEL_PATH — override model location (default: models/MiniCPM5-1B-Q4_K_M.gguf)
"""

from svg_agent.llm_backend import create_embedded_llm


def main() -> None:
    # Plain user utterance — the model's embedded chat template supplies
    # the surrounding control tokens (architectural agnosticism).
    prompt = "Say hi in one short sentence."

    print("[svg-agent] Loading model...")
    with create_embedded_llm() as llm:
        print("[svg-agent] Model loaded. Streaming reply:\n")
        for token in llm.stream(prompt, max_tokens=32):
            print(token, end="", flush=True)
    print("\n\n[svg-agent] Done.")


if __name__ == "__main__":
    main()