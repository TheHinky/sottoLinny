#!/bin/bash
# One-time Linux setup: build the server and install pinned model weights
# into .local/models. Afterwards use scripts/run-dev.sh start|stop|status.
set -euo pipefail

project_dir=$(cd "$(dirname "$0")/.." && pwd)
cd "$project_dir"
model_dir="$project_dir/.local/models"
qwen_file="$model_dir/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
qwen_url="https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/a06e946bb6b655725eafa393f4a9745d460374c9/Qwen3-4B-Instruct-2507-Q4_K_M.gguf"
qwen_sha256="3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597"

if [[ "$(uname -s)" != Linux ]]; then
    printf 'This script is for Linux. On macOS use scripts/run-dev.sh.\n' >&2
    exit 1
fi
if ! pkg-config --exists libcurl; then
    printf 'Missing libcurl headers. Install them first, e.g.:\n  sudo dnf install libcurl-devel   # Fedora\n  sudo apt install libcurl4-openssl-dev   # Ubuntu\n' >&2
    exit 1
fi

# --- Models (download and build in parallel) --------------------------------
mkdir -p "$model_dir"
download_models() {
    SOTTO_MODEL_DIR="$model_dir" ./scripts/download-model.sh
    if ! echo "$qwen_sha256  $qwen_file" | sha256sum --check --status 2>/dev/null; then
        curl --fail --location --retry 3 --continue-at - --output "$qwen_file.partial" "$qwen_url"
        echo "$qwen_sha256  $qwen_file.partial" | sha256sum --check --quiet
        mv "$qwen_file.partial" "$qwen_file"
    fi
}
download_models > "$project_dir/.local/model-download.log" 2>&1 &
download_pid=$!

# --- Build -------------------------------------------------------------------
SOTTO_BUILD_JOBS="${SOTTO_BUILD_JOBS:-$(nproc)}" ./scripts/build-server.sh

printf 'Build done. Waiting for model downloads (log: .local/model-download.log)...\n'
if ! wait "$download_pid"; then
    printf 'Model download failed. See .local/model-download.log.\n' >&2
    exit 1
fi
printf 'Setup complete. Start the server and client with: scripts/run-dev.sh start --skip-build\n'
