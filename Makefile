.PHONY: help install install-dev download-model run-hello test lint clean

# Default model for Phase 0 hello world
MODEL_URL := https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf
MODEL_DIR := models
MODEL_FILE := $(MODEL_DIR)/qwen2.5-0.5b-instruct-q4_k_m.gguf

help:
	@echo "svg-agent — Phase 0: Embed-an-LLM Hello World"
	@echo ""
	@echo "Targets:"
	@echo "  install        Install runtime dependencies (llama-cpp-python)"
	@echo "  install-dev    Install runtime + dev dependencies (pytest, ruff)"
	@echo "  download-model Download the GGUF model to models/"
	@echo "  run-hello      Run the hello world example"
	@echo "  test           Run smoke tests"
	@echo "  lint           Run ruff linter"
	@echo "  clean          Remove downloaded model and cache"

install:
	pip install -e .

install-dev:
	pip install -e ".[dev]"

download-model: $(MODEL_FILE)

$(MODEL_FILE):
	@mkdir -p $(MODEL_DIR)
	@echo "Downloading model (~450 MB)..."
	wget -q --show-progress -O "$(MODEL_FILE)" "$(MODEL_URL)"
	@echo "Model saved to $(MODEL_FILE)"

run-hello: $(MODEL_FILE)
	@echo "Running hello world..."
	@python examples/hello_world.py

test:
	pytest -v tests/

lint:
	ruff check src/ tests/ examples/

clean:
	rm -rf $(MODEL_DIR) __pycache__ .pytest_cache .ruff_cache
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true