#!/usr/bin/env python3

import argparse
import hashlib
import json
from pathlib import Path

from PIL import Image
from mflux.models.common.config import ModelConfig
from mflux.models.krea2.variants.txt2img.krea2 import Krea2
from mflux.utils.exceptions import StopImageGenerationException


def seed_for(image_id: str, candidate: int, seed_round: int) -> int:
    digest = hashlib.sha256(f"{image_id}:{seed_round}:{candidate}".encode()).digest()
    return int.from_bytes(digest[:4], "big") & 0x7FFFFFFF


def is_complete_image(path: Path, width: int, height: int) -> bool:
    if not path.exists() or path.stat().st_size == 0:
        return False
    try:
        with Image.open(path) as image:
            if image.size != (width, height):
                return False
            image.verify()
        return True
    except Exception:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate local Krea 2 candidates for offline DictProp images")
    parser.add_argument("targets")
    parser.add_argument("output_directory")
    parser.add_argument("--candidates", type=int, default=1)
    parser.add_argument(
        "--candidate-start",
        type=int,
        default=1,
        help="First candidate number to generate (inclusive)",
    )
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=576)
    parser.add_argument("--quantize", type=int, choices=(4, 8), default=None)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--seed-round", type=int, default=0)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--shard-index", type=int, default=0)
    args = parser.parse_args()

    payload = json.loads(Path(args.targets).read_text())
    targets = payload.get("targets")
    if not isinstance(targets, list):
        raise ValueError("Target manifest is invalid")
    if not targets:
        print("No image targets remain", flush=True)
        return
    if args.shard_count < 1 or args.shard_index < 0 or args.shard_index >= args.shard_count:
        raise ValueError("Invalid shard index/count")
    if args.steps < 4 or args.steps > 20:
        raise ValueError("Inference steps must be between 4 and 20")
    if args.candidate_start < 1 or args.candidate_start > args.candidates:
        raise ValueError("Candidate start must be between 1 and --candidates")
    targets = [target for index, target in enumerate(targets) if index % args.shard_count == args.shard_index]
    if not targets:
        print("No targets assigned to this shard", flush=True)
        return

    output = Path(args.output_directory)
    output.mkdir(parents=True, exist_ok=True)
    model = Krea2(model_config=ModelConfig.krea2(), quantize=args.quantize)
    failures = []
    quality_suffix = (
        " The image must teach the exact meaning at a glance: keep the defining action or relationship "
        "large, central, and visually unambiguous. Photorealistic documentary photography, plausible "
        "contemporary details, authentic anatomy and materials, natural light, no generic stock-photo posing, "
        "no metaphor unless the target itself is figurative, no illustration, no animation, no 3D render, "
        "no collage, no split screen, no visible text, no captions, no logos, no watermark."
    )

    for target_index, target in enumerate(targets, start=1):
        target_path = Path(target["filename"])
        stem = target_path.stem
        suffix = target_path.suffix.lower()
        if suffix not in (".jpg", ".jpeg", ".webp"):
            raise ValueError(f"Unsupported target image format: {target_path.suffix}")
        print(f"[{target_index}/{len(targets)}] {target['imageId']}", flush=True)
        for candidate_number in range(args.candidate_start, args.candidates + 1):
            candidate_index = candidate_number - 1
            path = output / f"{stem}-{candidate_number}{suffix}"
            if is_complete_image(path, args.width, args.height):
                continue
            path.unlink(missing_ok=True)
            try:
                image = model.generate_image(
                    seed=seed_for(target["imageId"], candidate_index, args.seed_round),
                    prompt=target["prompt"].strip() + quality_suffix,
                    num_inference_steps=args.steps,
                    height=args.height,
                    width=args.width,
                    guidance=1.0,
                    scheduler="er_sde",
                    negative_prompt=None,
                    image_path=None,
                    image_strength=None,
                )
                temporary_path = output / f".{path.name}.tmp"
                if suffix == ".webp":
                    image.image.save(temporary_path, format="WEBP", quality=90, method=6)
                else:
                    image.image.save(temporary_path, format="JPEG", quality=90, subsampling=2, optimize=True)
                temporary_path.replace(path)
            except StopImageGenerationException:
                temporary_path = output / f".{path.name}.tmp"
                temporary_path.unlink(missing_ok=True)
                raise
            except Exception as error:  # Continue so a long batch remains resumable.
                temporary_path = output / f".{path.name}.tmp"
                temporary_path.unlink(missing_ok=True)
                failures.append({"imageId": target["imageId"], "candidate": candidate_number, "error": str(error)})
                print(f"FAILED {target['imageId']} candidate {candidate_number}: {error}", flush=True)

    if failures:
        (output / "failures.json").write_text(json.dumps(failures, indent=2) + "\n")
        raise RuntimeError(f"{len(failures)} candidate generation(s) failed")


if __name__ == "__main__":
    main()
