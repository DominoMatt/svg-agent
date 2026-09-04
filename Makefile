.PHONY: help install install-dev download-model run-hello test lint clean run-batch run-propose

# Default model for Phase 0 hello world
MODEL_REPO := openbmb/MiniCPM5-1B-GGUF
MODEL_URL := https://huggingface.co/$(MODEL_REPO)/resolve/main/MiniCPM5-1B-Q4_K_M.gguf
MODEL_DIR := models
MODEL_FILE := $(MODEL_DIR)/MiniCPM5-1B-Q4_K_M.gguf

help:
	@echo "svg-agent — Lightweight SVG Studio Agent"
	@echo ""
	@echo "Targets:"
	@echo "  install         Install runtime dependencies (llama-cpp-python)"
	@echo "  install-dev     Install runtime + dev dependencies (pytest, ruff)"
	@echo "  download-model  Download the GGUF model to models/"
	@echo "  run-hello       Run the hello world example (M0)"
	@echo "  run-batch       Run batch_edit.py example (requires server)"
	@echo "  run-propose     Run variant_proposal.py example (requires server)"
	@echo "  test            Run all tests"
	@echo "  lint            Run ruff linter"
	@echo "  clean           Remove downloaded model and cache"

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

run-batch:
	@python examples/batch_edit.py fish --server http://localhost:3000

run-propose:
	@python examples/variant_proposal.py fish --server http://localhost:3000

test:
	pytest -v tests/

lint:
	ruff check src/ tests/ examples/

clean:
	rm -rf $(MODEL_DIR) __pycache__ .pytest_cache .ruff_cache
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true