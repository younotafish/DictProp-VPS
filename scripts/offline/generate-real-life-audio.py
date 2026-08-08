#!/usr/bin/env python3
"""Generate, align, validate, and checkpoint versioned Real Life TTS clips on Apple Silicon.

Run this inside a Python environment containing mlx-audio and soundfile. The output manifest is
directly consumable by import-offline-tts.ts and is updated after every accepted clip, so interruption
or a small --batch-size is safe.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

import mlx.core as mx
import numpy as np
import soundfile as sf
from mlx_audio.stt.utils import load_model as load_stt_model
from mlx_audio.tts.utils import load_model as load_tts_model


DEFAULT_TTS_MODEL = "mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
DEFAULT_ALIGNER_MODEL = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"
VOICE = "Aiden"
VOICE_TOKENS = {
    "clear": "qwen3-aiden-clear-v1",
    "casual": "qwen3-aiden-casual-v1",
}
INSTRUCTIONS = {
    "clear": (
        "Speak in natural, polished General American English at a calm conversational pace. "
        "Be articulate but not theatrical, use realistic sentence stress, and preserve every word exactly."
    ),
    "casual": (
        "Speak in relaxed, spontaneous General American English at a brisk conversational pace, "
        "using natural linking and reductions. Stay intelligible and preserve every word exactly; do not paraphrase."
    ),
}
STYLE_WPM_BOUNDS = {
    "clear": (85, 245),
    "casual": (105, 285),
}
STYLE_WPM_NORMALIZATION_TARGETS = {
    "clear": (105, 225),
    "casual": (125, 265),
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate Qwen3-TTS Real Life audio with word alignment")
    parser.add_argument("--catalog", default="content/real-life-catalog.json")
    parser.add_argument("--output", default="data/offline-backfill/real-life-qwen3-audio")
    parser.add_argument("--model", default=DEFAULT_TTS_MODEL)
    parser.add_argument("--aligner", default=DEFAULT_ALIGNER_MODEL)
    parser.add_argument("--collection", action="append", default=[], help="Collection id; repeat to select several")
    parser.add_argument("--style", choices=["clear", "casual", "both"], default="both")
    parser.add_argument("--limit", type=int, default=0, help="Limit unique sentences before expanding styles")
    parser.add_argument("--batch-size", type=int, default=0, help="Generate at most this many new clips")
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--ffmpeg", default=os.environ.get("FFMPEG_BIN", "/Users/cjs/.local/bin/ffmpeg"))
    return parser.parse_args()


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def cache_key(text: str, voice: str) -> str:
    return hashlib.sha256(f"{voice}\n{text.strip()}".encode("utf-8")).hexdigest()


def strip_markers(text: str) -> str:
    return re.sub(r"\[\[(.+?)\]\]", r"\1", re.sub(r"\{\{(.+?)\}\}", r"\1", text or "")).strip()


def load_sentences(path: Path, collections: set[str], limit: int) -> list[str]:
    source = json.loads(path.read_text(encoding="utf-8"))
    seen: set[str] = set()
    sentences: list[str] = []
    for collection in source.get("collections", []):
        if collections and collection.get("id") not in collections:
            continue
        for section in collection.get("sections", []):
            for sentence in section.get("sentences", []):
                text = strip_markers(str(sentence.get("text", "")))
                identity = " ".join(text.casefold().split())
                if not text or identity in seen:
                    continue
                seen.add(identity)
                sentences.append(text)
                if limit > 0 and len(sentences) >= limit:
                    return sentences
    return sentences


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary, path)


def duration_seconds(path: Path) -> float:
    return float(sf.info(path).duration)


def transcode(wav_path: Path, mp3_path: Path, ffmpeg: str, tempo: float = 1.0) -> None:
    mp3_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = mp3_path.with_suffix(".mp3.tmp")
    filters = []
    if not math.isclose(tempo, 1.0, abs_tol=0.001):
        filters.append(f"atempo={tempo:.6f}")
    filters.append("loudnorm=I=-18:TP=-2:LRA=7")
    subprocess.run(
        [
            ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav_path),
            "-af", ",".join(filters), "-ar", "24000", "-ac", "1", "-b:a", "80k",
            "-f", "mp3", str(temporary),
        ],
        check=True,
        timeout=90,
    )
    os.replace(temporary, mp3_path)


def validate_waveform(audio: np.ndarray, sample_rate: int, text: str, style: str) -> dict[str, float]:
    if audio.ndim > 1:
        audio = np.mean(audio, axis=1)
    if audio.size == 0 or not np.isfinite(audio).all() or sample_rate < 16_000:
        raise ValueError("waveform is empty, non-finite, or undersampled")
    duration = audio.size / sample_rate
    peak = float(np.max(np.abs(audio)))
    rms = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64))))
    clipping = float(np.mean(np.abs(audio) >= 0.995))
    words = max(1, len(re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*", text)))
    wpm = words / duration * 60
    if not 0.5 <= duration <= 90:
        raise ValueError(f"duration {duration:.2f}s is outside the quality gate")
    if peak < 0.02 or rms < 0.004 or clipping > 0.01:
        raise ValueError(f"level gate failed: peak={peak:.4f} rms={rms:.4f} clipping={clipping:.4f}")
    if not 50 <= wpm <= 400:
        raise ValueError(f"speaking rate {wpm:.1f} WPM is too extreme to normalize safely")
    return {"duration": duration, "peak": peak, "rms": rms, "clipping": clipping, "wpm": wpm}


def tempo_for_style(raw_wpm: float, style: str) -> float:
    minimum, maximum = STYLE_WPM_BOUNDS[style]
    target_minimum, target_maximum = STYLE_WPM_NORMALIZATION_TARGETS[style]
    if raw_wpm < minimum:
        return target_minimum / raw_wpm
    if raw_wpm > maximum:
        return target_maximum / raw_wpm
    return 1.0


def generate_waveform(model: Any, text: str, style: str, seed: int) -> tuple[np.ndarray, int]:
    mx.random.seed(seed)
    chunks: list[np.ndarray] = []
    sample_rate = int(model.sample_rate)
    for result in model.generate(
        text=text,
        voice=VOICE,
        instruct=INSTRUCTIONS[style],
        lang_code="english",
        temperature=0.72 if style == "clear" else 0.82,
        top_k=35,
        top_p=0.92,
        repetition_penalty=1.08,
        max_tokens=1200,
        verbose=False,
    ):
        chunks.append(np.asarray(result.audio, dtype=np.float32).reshape(-1))
        sample_rate = int(result.sample_rate)
    if not chunks:
        raise ValueError("model returned no audio")
    return np.concatenate(chunks), sample_rate


def align_words(aligner: Any, audio_path: Path, text: str, duration: float) -> list[dict[str, Any]]:
    result = aligner.generate(audio=str(audio_path), text=text, language="English")
    timings = []
    for item in result.items:
        start = float(item.start_time)
        end = float(item.end_time)
        # The Qwen aligner occasionally places a very short article at the exact shared boundary
        # between its neighbours (for example, `a: 0.80-0.80`). Preserve that word with a bounded
        # 40 ms seek target; overlaps below 50 ms are accepted by the client and importer.
        if -0.001 <= end - start < 0.02:
            center = (start + end) / 2
            start = max(0.0, center - 0.02)
            end = min(duration, center + 0.02)
        timings.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "text": str(item.text),
        })
    expected = re.findall(r"[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*", text)
    if len(timings) < max(1, math.floor(len(expected) * 0.85)) or len(timings) > len(expected) + 3:
        raise ValueError(f"aligner returned {len(timings)} words for {len(expected)} expected")
    previous = 0.0
    for timing in timings:
        if timing["start"] < 0 or timing["end"] <= timing["start"] or timing["start"] + 0.05 < previous:
            raise ValueError("aligner returned malformed or non-monotonic timings")
        previous = timing["end"]
    if previous > duration + 0.75:
        raise ValueError("alignment exceeds audio duration")
    return timings


def valid_existing_entry(root: Path, entry: dict[str, Any]) -> bool:
    try:
        audio = (root / entry["audioFile"]).read_bytes()
        timings = (root / entry["timingsFile"]).read_bytes()
        return sha256_bytes(audio) == entry["audioSha256"] and sha256_bytes(timings) == entry["timingsSha256"]
    except (KeyError, OSError):
        return False


def main() -> None:
    args = parse_args()
    catalog_path = Path(args.catalog).resolve()
    output_root = Path(args.output).resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    manifest_path = output_root / "manifest.json"
    sentences = load_sentences(catalog_path, set(args.collection), max(0, args.limit))
    styles = ["clear", "casual"] if args.style == "both" else [args.style]
    targets = [(text, style) for text in sentences for style in styles]
    if not targets:
        raise SystemExit("No catalog sentences matched the requested selection")

    manifest: dict[str, Any] = {
        "version": 1,
        "generatedAt": int(time.time() * 1000),
        "model": args.model,
        "aligner": args.aligner,
        "entries": [],
    }
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text(encoding="utf-8"))
        if previous.get("version") != 1 or previous.get("model") != args.model or previous.get("aligner") != args.aligner:
            raise SystemExit("Existing manifest uses a different model or aligner; choose another output directory")
        manifest = previous

    entries_by_key = {
        entry["key"]: entry
        for entry in manifest.get("entries", [])
        if isinstance(entry, dict) and valid_existing_entry(output_root, entry)
    }
    manifest["entries"] = sorted(entries_by_key.values(), key=lambda entry: entry["key"])
    atomic_json(manifest_path, manifest)
    missing = [
        (text, style, cache_key(text, VOICE_TOKENS[style]))
        for text, style in targets
        if cache_key(text, VOICE_TOKENS[style]) not in entries_by_key
    ]
    if args.batch_size > 0:
        missing = missing[: args.batch_size]
    print(f"Ready: {len(entries_by_key)}/{len(targets)}; generating {len(missing)} clip(s)", flush=True)
    if not missing:
        return

    print(f"Loading TTS model {args.model}", flush=True)
    tts_model = load_tts_model(args.model)
    print(f"Loading forced aligner {args.aligner}", flush=True)
    aligner = load_stt_model(args.aligner)

    accepted = 0
    with tempfile.TemporaryDirectory(prefix="dictprop-qwen3-tts-") as temporary_root:
        temporary = Path(temporary_root)
        for index, (text, style, key) in enumerate(missing, 1):
            last_error: Exception | None = None
            for attempt in range(max(1, args.attempts)):
                try:
                    wav_path = temporary / f"{key}.wav"
                    relative_audio = f"audio/{key[:2]}/{key}.mp3"
                    relative_timings = f"audio/{key[:2]}/{key}.json"
                    audio_path = output_root / relative_audio
                    timings_path = output_root / relative_timings
                    audio, sample_rate = generate_waveform(tts_model, text, style, int(key[:12], 16) + attempt)
                    raw_metrics = validate_waveform(audio, sample_rate, text, style)
                    sf.write(wav_path, audio, sample_rate, subtype="PCM_16")
                    tempo = tempo_for_style(raw_metrics["wpm"], style)
                    transcode(wav_path, audio_path, args.ffmpeg, tempo)
                    processed_audio, processed_sample_rate = sf.read(audio_path, dtype="float32")
                    metrics = validate_waveform(processed_audio, int(processed_sample_rate), text, style)
                    minimum_wpm, maximum_wpm = STYLE_WPM_BOUNDS[style]
                    if not minimum_wpm <= metrics["wpm"] <= maximum_wpm:
                        raise ValueError(
                            f"normalized speaking rate {metrics['wpm']:.1f} WPM is outside the {style} gate"
                        )
                    duration = duration_seconds(audio_path)
                    timings = align_words(aligner, audio_path, text, duration)
                    timings_path.parent.mkdir(parents=True, exist_ok=True)
                    atomic_json(timings_path, timings)
                    audio_bytes = audio_path.read_bytes()
                    timings_bytes = timings_path.read_bytes()
                    entry = {
                        "key": key,
                        "voice": VOICE_TOKENS[style],
                        "text": text,
                        "audioFile": relative_audio,
                        "timingsFile": relative_timings,
                        "audioSha256": sha256_bytes(audio_bytes),
                        "timingsSha256": sha256_bytes(timings_bytes),
                        "durationSeconds": round(duration, 3),
                    }
                    entries_by_key[key] = entry
                    manifest["generatedAt"] = int(time.time() * 1000)
                    manifest["entries"] = sorted(entries_by_key.values(), key=lambda value: value["key"])
                    atomic_json(manifest_path, manifest)
                    accepted += 1
                    print(
                        f"[{index}/{len(missing)}] accepted {style} {key[:10]} "
                        f"{duration:.2f}s {metrics['wpm']:.0f}wpm",
                        flush=True,
                    )
                    break
                except Exception as error:  # quality failure is retryable with a deterministic alternate seed
                    last_error = error
                    print(f"[{index}/{len(missing)}] retry {attempt + 1}: {error}", flush=True)
            else:
                raise RuntimeError(f"Failed {style} clip after {args.attempts} attempts: {text}\n{last_error}")

    print(f"Accepted {accepted} new clip(s); manifest now contains {len(entries_by_key)}", flush=True)


if __name__ == "__main__":
    main()
