#!/usr/bin/env python3
"""Long-lived, offline-only MLX vision-language worker using JSON Lines IPC."""

from __future__ import annotations

import argparse
import json
import os
import sys
import traceback
from pathlib import Path


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    args = parser.parse_args()

    model_path = Path(args.model).expanduser().resolve()
    if not model_path.is_dir():
        raise RuntimeError(
            f"Local MLX vision model is missing: {model_path}. "
            "Run scripts/offline/bootstrap-local-ai-runtime.sh first."
        )

    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    import mlx.core as mx
    from mlx_vlm import generate, load
    from mlx_vlm.prompt_utils import apply_chat_template

    model, processor = load(str(model_path))
    config = model.config
    emit({"type": "ready", "model": str(model_path)})

    for raw_line in sys.stdin:
        if not raw_line.strip():
            continue
        request_id = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            prompt = request.get("prompt")
            images = request.get("images")
            if not isinstance(request_id, int) or not isinstance(prompt, str) or not prompt.strip():
                raise ValueError("request requires an integer id and nonempty prompt")
            if not isinstance(images, list) or not images:
                raise ValueError("vision request requires at least one image")
            image_paths = [str(Path(path).expanduser().resolve()) for path in images]
            if any(not Path(path).is_file() for path in image_paths):
                raise ValueError("vision request contains a missing image")

            max_tokens = max(64, min(4096, int(request.get("maxTokens", 1200))))
            temperature = max(0.0, min(1.5, float(request.get("temperature", 0.0))))
            formatted = apply_chat_template(
                processor,
                config,
                prompt,
                num_images=len(image_paths),
            )
            result = generate(
                model,
                processor,
                formatted,
                image_paths,
                max_tokens=max_tokens,
                temperature=temperature,
                verbose=False,
            )
            text = result.text if hasattr(result, "text") else str(result)
            emit({"type": "result", "id": request_id, "text": text})
            mx.clear_cache()
        except Exception as error:
            traceback.print_exc(file=sys.stderr)
            emit({"type": "error", "id": request_id, "error": str(error)})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
