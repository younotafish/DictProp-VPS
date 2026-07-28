#!/usr/bin/env python3

import argparse
import gc
import hashlib
import json
from pathlib import Path

import mlx.core as mx
from PIL import Image
from mflux.models.common.config import ModelConfig
from mflux.models.ernie_image import ErnieImage
from mflux.models.krea2.variants.txt2img.krea2 import Krea2
from mflux.models.qwen.variants.edit.qwen_image_edit import QwenImageEdit
from mflux.models.qwen.variants.txt2img.qwen_image import QwenImage
from mflux.models.z_image import ZImage
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
    parser = argparse.ArgumentParser(description="Generate local image candidates for offline DictProp images")
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
    parser.add_argument(
        "--model",
        choices=(
            "krea2",
            "ernie-image",
            "ernie-image-turbo",
            "qwen-image",
            "qwen-image-edit",
            "z-image-turbo",
        ),
        default="krea2",
    )
    parser.add_argument("--quantize", type=int, choices=(4, 8), default=None)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--seed-round", type=int, default=0)
    parser.add_argument("--image-source-candidate", type=int, default=None)
    parser.add_argument("--image-strength", type=float, default=None)
    parser.add_argument("--shard-count", type=int, default=1)
    parser.add_argument("--shard-index", type=int, default=0)
    parser.add_argument(
        "--accepted-directory",
        help="Skip targets that already have a complete accepted image in this directory",
    )
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
    if args.steps < 4 or args.steps > 60:
        raise ValueError("Inference steps must be between 4 and 60")
    if args.candidate_start < 1 or args.candidate_start > args.candidates:
        raise ValueError("Candidate start must be between 1 and --candidates")
    if args.model == "qwen-image-edit":
        if args.image_source_candidate is None:
            raise ValueError("Qwen image editing requires --image-source-candidate")
        if args.image_strength is not None:
            raise ValueError("Qwen image editing does not use --image-strength")
    elif (args.image_source_candidate is None) != (args.image_strength is None):
        raise ValueError("--image-source-candidate and --image-strength must be provided together")
    if args.image_source_candidate is not None:
        if args.image_source_candidate < 1 or args.image_source_candidate > 99:
            raise ValueError("Image source candidate must be between 1 and 99")
    if args.image_strength is not None:
        if not 0.0 < args.image_strength <= 1.0:
            raise ValueError("Image strength must be greater than 0 and at most 1")
    if args.accepted_directory:
        accepted_directory = Path(args.accepted_directory)
        targets = [
            target
            for target in targets
            if not is_complete_image(accepted_directory / target["filename"], args.width, args.height)
        ]
    targets = [target for index, target in enumerate(targets) if index % args.shard_count == args.shard_index]
    if not targets:
        print("No targets assigned to this shard", flush=True)
        return

    output = Path(args.output_directory)
    output.mkdir(parents=True, exist_ok=True)

    def target_needs_generation(target: dict) -> bool:
        target_path = Path(target["filename"])
        return any(
            not is_complete_image(
                output / f"{target_path.stem}-{candidate_number}{target_path.suffix.lower()}",
                args.width,
                args.height,
            )
            for candidate_number in range(args.candidate_start, args.candidates + 1)
        )

    targets = [target for target in targets if target_needs_generation(target)]
    if not targets:
        print("All candidates assigned to this shard are already complete", flush=True)
        return

    if args.model == "ernie-image-turbo":
        model = ErnieImage(model_config=ModelConfig.ernie_image_turbo(), quantize=args.quantize)
    elif args.model == "ernie-image":
        model = ErnieImage(model_config=ModelConfig.ernie_image(), quantize=args.quantize)
    elif args.model == "qwen-image":
        model = QwenImage(model_config=ModelConfig.qwen_image(), quantize=args.quantize)
    elif args.model == "qwen-image-edit":
        model = QwenImageEdit(model_config=ModelConfig.qwen_image_edit(), quantize=args.quantize)
    elif args.model == "z-image-turbo":
        model = ZImage(model_config=ModelConfig.z_image_turbo(), quantize=args.quantize)
    else:
        model = Krea2(model_config=ModelConfig.krea2(), quantize=args.quantize)
    failures = []
    quality_suffix = (
        " Keep the one defining action or relationship large and central, with realistic anatomy and objects. "
        "No visible text, illustration, animation, 3D render, collage, logos, or watermark."
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
                source_path = None
                if args.image_source_candidate is not None:
                    possible_source = output / f"{stem}-{args.image_source_candidate}{suffix}"
                    if is_complete_image(possible_source, args.width, args.height):
                        source_path = possible_source
                prompt = target["prompt"].strip() + quality_suffix
                if args.model == "qwen-image-edit":
                    if source_path is None:
                        raise FileNotFoundError(
                            f"Missing source candidate {args.image_source_candidate} for {target['imageId']}"
                        )
                    generated = model.generate_image(
                        seed=seed_for(target["imageId"], candidate_index, args.seed_round),
                        prompt=(
                            "Edit the source photograph to teach the exact learning target at a glance. "
                            f"Correct this prior failure: {target.get('rejectionReason', 'the meaning was unclear')} "
                            f"The finished image must match this brief: {prompt}"
                        ),
                        image_paths=[str(source_path)],
                        num_inference_steps=args.steps,
                        height=args.height,
                        width=args.width,
                        guidance=4.0,
                        scheduler="linear",
                        negative_prompt=None,
                    )
                else:
                    generated = model.generate_image(
                        seed=seed_for(target["imageId"], candidate_index, args.seed_round),
                        prompt=prompt,
                        num_inference_steps=args.steps,
                        height=args.height,
                        width=args.width,
                        guidance=4.0 if args.model in ("ernie-image", "qwen-image") else 1.0,
                        scheduler=(
                            "linear"
                            if args.model == "qwen-image"
                            else (("euler" if source_path else "er_sde") if args.model == "krea2" else None)
                        ),
                        negative_prompt=None,
                        image_path=source_path,
                        image_strength=args.image_strength if source_path else None,
                    )
                image = getattr(generated, "image", generated)
                temporary_path = output / f".{path.name}.tmp"
                if suffix == ".webp":
                    image.save(temporary_path, format="WEBP", quality=90, method=6)
                else:
                    image.save(temporary_path, format="JPEG", quality=90, subsampling=2, optimize=True)
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
            finally:
                prompt_cache = getattr(model, "prompt_cache", None)
                if isinstance(prompt_cache, dict):
                    prompt_cache.clear()
                gc.collect()
                mx.clear_cache()

    if failures:
        (output / "failures.json").write_text(json.dumps(failures, indent=2) + "\n")
        raise RuntimeError(f"{len(failures)} candidate generation(s) failed")


if __name__ == "__main__":
    main()
