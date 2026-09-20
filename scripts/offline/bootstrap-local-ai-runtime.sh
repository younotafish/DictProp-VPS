#!/usr/bin/env bash

set -euo pipefail

CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/dictprop/local-ai"
VLM_ENV="${XDG_CACHE_HOME:-$HOME/.cache}/dictprop/local-vlm"
PYTHON_BIN="${PYTHON_BIN:-/usr/local/bin/python3}"
UV_BIN="${UV_BIN:-${XDG_CACHE_HOME:-$HOME/.cache}/dictprop/mflux/bin/uv}"
TEXT_MODEL_ID="${LOCAL_MLX_MODEL_ID:-mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit}"
TEXT_MODEL_DIR="${LOCAL_MLX_MODEL:-$CACHE_ROOT/models/Qwen3-30B-A3B-Instruct-2507-4bit}"
VLM_MODEL_ID="${LOCAL_MLX_VLM_MODEL_ID:-mlx-community/Qwen3-VL-8B-Instruct-4bit}"
VLM_MODEL_DIR="${LOCAL_MLX_VLM_MODEL:-$CACHE_ROOT/models/Qwen3-VL-8B-Instruct-4bit}"

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "The local MLX runtime requires an Apple-silicon Mac." >&2
  exit 1
fi
if [ ! -x "$UV_BIN" ]; then
  echo "uv is missing: $UV_BIN (bootstrap the existing mflux runtime first)." >&2
  exit 1
fi

mkdir -p "$CACHE_ROOT/models"
if [ ! -x "$CACHE_ROOT/bin/python" ]; then
  "$UV_BIN" venv --python "$PYTHON_BIN" "$CACHE_ROOT"
fi
"$UV_BIN" pip install --python "$CACHE_ROOT/bin/python" \
  'mlx==0.31.2' 'mlx-metal==0.31.2' 'mlx-lm==0.31.3' \
  'huggingface-hub>=1.4.1' 'click>=8.1'

"$CACHE_ROOT/bin/hf" download "$TEXT_MODEL_ID" --local-dir "$TEXT_MODEL_DIR"

if [ "${SKIP_LOCAL_VLM:-0}" != 1 ]; then
  if [ ! -x "$VLM_ENV/bin/python" ]; then
    "$UV_BIN" venv --python "$PYTHON_BIN" "$VLM_ENV"
  fi
  "$UV_BIN" pip install --python "$VLM_ENV/bin/python" \
    'mlx==0.31.2' 'mlx-metal==0.31.2' 'mlx-lm==0.29.1' \
    'mlx-vlm==0.3.4' 'transformers==4.57.6' \
    'huggingface-hub>=0.34,<1' 'click>=8.1' \
    'torch==2.8.0' 'torchvision==0.23.0'
  "$CACHE_ROOT/bin/hf" download "$VLM_MODEL_ID" --local-dir "$VLM_MODEL_DIR"
fi

echo "Local text model: $TEXT_MODEL_DIR"
if [ "${SKIP_LOCAL_VLM:-0}" != 1 ]; then
  echo "Local vision model: $VLM_MODEL_DIR"
fi
