#!/usr/bin/env python3
"""Render reproducible Qwen3-TTS variants for a human connected-speech A/B test.

This intentionally does not choose a winner from ASR or timing metrics. Those gates can catch
omissions and malformed audio, but only blinded listening can establish comparative naturalness.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import mlx.core as mx
import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model as load_tts_model


DEFAULT_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
TEST_SENTENCES = [
    "I'd have brought it up earlier, but I didn't want to put you on the spot.",
    "If we'd known the kitchen was closing, we would've placed the order a little sooner.",
    "Could you walk me through what we're supposed to do if the connection gets canceled?",
    "We're going to have to take the next train unless they hold this one for us.",
    "Do you want to grab a quick bite after we check into the hotel?",
]
RECIPES = [
    {
        "id": "current-clear-aiden",
        "speaker": "Aiden",
        "instruct": (
            "Speak in natural, polished General American English at a calm conversational pace. "
            "Be articulate but not theatrical, use realistic sentence stress, and preserve every word exactly."
        ),
        "temperature": 0.72,
        "top_k": 35,
        "top_p": 0.92,
        "repetition_penalty": 1.08,
    },
    {
        "id": "current-casual-aiden",
        "speaker": "Aiden",
        "instruct": (
            "Speak in relaxed, spontaneous General American English at a brisk conversational pace, "
            "using natural linking and reductions. Stay intelligible and preserve every word exactly; do not paraphrase."
        ),
        "temperature": 0.82,
        "top_k": 35,
        "top_p": 0.92,
        "repetition_penalty": 1.08,
    },
    {
        "id": "official-default-aiden",
        "speaker": "Aiden",
        "instruct": None,
        "temperature": 0.9,
        "top_k": 50,
        "top_p": 1.0,
        "repetition_penalty": 1.05,
    },
    {
        "id": "concise-conversation-aiden",
        "speaker": "Aiden",
        "instruct": "Speak casually to one person in a real conversation, with relaxed American rhythm and natural phrasing.",
        "temperature": 0.9,
        "top_k": 50,
        "top_p": 1.0,
        "repetition_penalty": 1.05,
    },
    {
        "id": "concise-conversation-ryan",
        "speaker": "Ryan",
        "instruct": "Speak casually to one person in a real conversation, with relaxed American rhythm and natural phrasing.",
        "temperature": 0.9,
        "top_k": 50,
        "top_p": 1.0,
        "repetition_penalty": 1.05,
    },
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate Qwen connected-speech listening samples")
    parser.add_argument("--output", default="data/offline-backfill/tts-naturalness-benchmark/qwen")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--sentence-limit", type=int, default=0)
    parser.add_argument("--recipe", action="append", default=[], help="Recipe id; repeat to select several")
    parser.add_argument("--force", action="store_true", help="Regenerate existing clips")
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_BIN", "/Users/cjs/.local/bin/ffmpeg"))
    return parser.parse_args()


def render(model: Any, text: str, recipe: dict[str, Any], seed: int) -> tuple[np.ndarray, int]:
    mx.random.seed(seed)
    chunks: list[np.ndarray] = []
    sample_rate = int(model.sample_rate)
    for result in model.generate(
        text=text,
        voice=recipe["speaker"],
        instruct=recipe["instruct"],
        lang_code="english",
        temperature=recipe["temperature"],
        top_k=recipe["top_k"],
        top_p=recipe["top_p"],
        repetition_penalty=recipe["repetition_penalty"],
        max_tokens=1200,
        verbose=False,
    ):
        chunks.append(np.asarray(result.audio, dtype=np.float32).reshape(-1))
        sample_rate = int(result.sample_rate)
    if not chunks:
        raise RuntimeError("Qwen returned no audio")
    return np.concatenate(chunks), sample_rate


def transcode(wav_path: Path, mp3_path: Path, ffmpeg: str) -> None:
    subprocess.run(
        [
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav_path),
            "-af", "loudnorm=I=-18:TP=-2:LRA=7", "-ar", "24000", "-ac", "1", "-b:a", "96k",
            str(mp3_path),
        ],
        check=True,
        timeout=90,
    )


def main() -> None:
    args = parse_args()
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    selected = [recipe for recipe in RECIPES if not args.recipe or recipe["id"] in set(args.recipe)]
    unknown = set(args.recipe) - {recipe["id"] for recipe in RECIPES}
    if unknown:
        raise SystemExit(f"Unknown recipe(s): {', '.join(sorted(unknown))}")
    sentences = TEST_SENTENCES[: args.sentence_limit or None]
    print(f"Loading {args.model}", flush=True)
    model = load_tts_model(args.model)
    entries: list[dict[str, Any]] = []
    with tempfile.TemporaryDirectory(prefix="dictprop-qwen-listening-") as temporary_root:
        temporary = Path(temporary_root)
        for sentence_index, text in enumerate(sentences):
            for recipe in selected:
                identity = f"{args.model}\n{recipe['id']}\n{text}"
                digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()
                seed_digest = hashlib.sha256(f"{recipe['id']}\n{text}".encode("utf-8")).hexdigest()
                output_path = root / f"{digest}.mp3"
                if args.force or not output_path.exists():
                    audio, sample_rate = render(model, text, recipe, int(seed_digest[:12], 16))
                    wav_path = temporary / f"{digest}.wav"
                    sf.write(wav_path, audio, sample_rate, subtype="PCM_16")
                    transcode(wav_path, output_path, args.ffmpeg)
                duration = float(sf.info(output_path).duration)
                entries.append({
                    "sentenceIndex": sentence_index,
                    "text": text,
                    "recipe": recipe["id"],
                    "speaker": recipe["speaker"],
                    "file": output_path.name,
                    "durationSeconds": round(duration, 3),
                })
                print(f"[{sentence_index + 1}/{len(sentences)}] {recipe['id']} {duration:.2f}s", flush=True)
    manifest = {
        "version": 1,
        "generatedAt": int(time.time() * 1000),
        "model": args.model,
        "recipes": selected,
        "entries": entries,
    }
    temporary_manifest = root / "manifest.json.tmp"
    temporary_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary_manifest, root / "manifest.json")


if __name__ == "__main__":
    main()
