#!/usr/bin/env python3
"""
Phase 0 Hello World — Embed an LLM in-process and stream a greeting.

Usage:
    python examples/hello_world.py

Environment:
    SVG_MODEL_PATH — override model location (default: models/qwen2.5-0.5b-instruct-q4_k_m.gguf)
"""

from svg_agent.llm_backend import create_embedded_llm


def main() -> None:
    # Qwen2.5 chat template: <|im_start|>user\n...<|im_end|>\n<|im_start|>assistant\n
    prompt = "<|im_start|>user\nSay hi in one short sentence.<|im_end|>\n<|im_start|>assistant\n"

    print("[svg-agent] Loading model...")
    with create_embedded_llm() as llm:
        print("[svg-agent] Model loaded. Streaming reply:\n")
        for token in llm.stream(prompt, max_tokens=32):
            print(token, end="", flush=True)
    print("\n\n[svg-agent] Done.")


if __name__ == "__main__":
    main()