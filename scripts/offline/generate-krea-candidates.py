#!/usr/bin/env python3

import argparse
import hashlib
import json
from pathlib import Path

from mflux.models.common.config import ModelConfig
from mflux.models.krea2.variants.txt2img.krea2 import Krea2


def seed_for(image_id: str, candidate: int) -> int:
    digest = hashlib.sha256(f"{image_id}:{candidate}".encode()).digest()
    return int.from_bytes(digest[:4], "big") & 0x7FFFFFFF


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate local Krea 2 candidates for offline DictProp images")
    parser.add_argument("targets")
    parser.add_argument("output_directory")
    parser.add_argument("--candidates", type=int, default=3)
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=720)
    parser.add_argument("--quantize", type=int, choices=(4, 8), default=None)
    args = parser.parse_args()

    payload = json.loads(Path(args.targets).read_text())
    targets = payload.get("targets")
    if not isinstance(targets, list) or not targets:
        raise ValueError("Target manifest is invalid or empty")

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
        stem = Path(target["filename"]).stem
        print(f"[{target_index}/{len(targets)}] {target['imageId']}", flush=True)
        for candidate in range(args.candidates):
            path = output / f"{stem}-{candidate + 1}.jpg"
            if path.exists() and path.stat().st_size > 0:
                continue
            try:
                image = model.generate_image(
                    seed=seed_for(target["imageId"], candidate),
                    prompt=target["prompt"].strip() + quality_suffix,
                    num_inference_steps=8,
                    height=args.height,
                    width=args.width,
                    guidance=1.0,
                    scheduler="er_sde",
                    negative_prompt=None,
                    image_path=None,
                    image_strength=None,
                )
                image.image.save(path, format="JPEG", quality=94, subsampling=0, optimize=True)
            except Exception as error:  # Continue so a long batch remains resumable.
                failures.append({"imageId": target["imageId"], "candidate": candidate + 1, "error": str(error)})
                print(f"FAILED {target['imageId']} candidate {candidate + 1}: {error}", flush=True)

    if failures:
        (output / "failures.json").write_text(json.dumps(failures, indent=2) + "\n")
        raise RuntimeError(f"{len(failures)} candidate generation(s) failed")


if __name__ == "__main__":
    main()
