#!/usr/bin/env python3
"""Long-lived, offline-only MLX text-generation worker using JSON Lines IPC."""

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
            f"Local MLX model is missing: {model_path}. "
            "Run scripts/offline/bootstrap-local-ai-runtime.sh first."
        )

    # A recurring repair must never turn a missing local artifact into an accidental download.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

    import mlx.core as mx
    from mlx_lm import generate, load
    from mlx_lm.sample_utils import make_sampler

    model, tokenizer = load(str(model_path), lazy=False)
    emit({"type": "ready", "model": str(model_path)})

    for raw_line in sys.stdin:
        if not raw_line.strip():
            continue
        request_id = None
        try:
            request = json.loads(raw_line)
            request_id = request.get("id")
            prompt = request.get("prompt")
            if not isinstance(request_id, int) or not isinstance(prompt, str) or not prompt.strip():
                raise ValueError("request requires an integer id and nonempty prompt")

            max_tokens = max(64, min(32768, int(request.get("maxTokens", 8192))))
            temperature = max(0.0, min(1.5, float(request.get("temperature", 0.0))))
            messages = [
                {
                    "role": "system",
                    "content": (
                        "Follow the user's instructions exactly. Return only the requested JSON, "
                        "with no Markdown fence or commentary."
                    ),
                },
                {"role": "user", "content": prompt},
            ]
            template_options = {
                "tokenize": False,
                "add_generation_prompt": True,
            }
            try:
                formatted = tokenizer.apply_chat_template(
                    messages,
                    enable_thinking=False,
                    **template_options,
                )
            except TypeError:
                formatted = tokenizer.apply_chat_template(messages, **template_options)

            sampler = make_sampler(
                temp=temperature,
                top_p=0.9 if temperature > 0 else 0.0,
                min_p=0.02 if temperature > 0 else 0.0,
            )
            result = generate(
                model,
                tokenizer,
                formatted,
                max_tokens=max_tokens,
                sampler=sampler,
                verbose=False,
            )
            emit({"type": "result", "id": request_id, "text": result})
            mx.clear_cache()
        except Exception as error:  # Keep the worker alive so the caller can retry a corrected prompt.
            traceback.print_exc(file=sys.stderr)
            emit({"type": "error", "id": request_id, "error": str(error)})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
