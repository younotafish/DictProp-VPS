# Offline TTS evaluation

Evaluated on 2026-08-08 for the Real Life sentence catalog. The production target is locally
generated speech that can be imported into the VPS cache in small, resumable batches. The VPS does
not run the model.

## Decision

Use `mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit` with the built-in **Aiden** voice and two
versioned recipes:

- `qwen3-aiden-clear-v1`: polished, conversational General American English
- `qwen3-aiden-casual-v1`: brisk, linked, naturally reduced General American English

Qwen's official description calls Aiden a sunny American male voice with a clear midrange. The
1.7B CustomVoice model supports English and natural-language control over pace, prosody, and style.
The upstream model is Apache-2.0; MLX-Audio, the Apple-Silicon inference runtime, is MIT licensed.

Sources:

- [Qwen3-TTS official repository](https://github.com/QwenLM/Qwen3-TTS)
- [Qwen3-TTS official model collection](https://huggingface.co/collections/Qwen/qwen3-tts)
- [MLX-Audio](https://github.com/Blaizzy/mlx-audio)
- [MLX Qwen3-TTS model](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit)
- [MLX Qwen forced aligner](https://huggingface.co/mlx-community/Qwen3-ForcedAligner-0.6B-8bit)

## Local A/B against MiMo-V2.5-TTS

Five executive-communication sentences (71 reference words) were rendered with both engines. The
Qwen casual recipe was evaluated separately. Whisper Large V3 Turbo was used as an independent ASR
check; it was not given the reference transcript. All generated Qwen clips also passed waveform,
speaking-rate, and forced-alignment gates.

| Track | ASR word errors | Mean ASR log probability | Mean word confidence | Mean duration | Mean longest pause |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen clear | 0 / 71 | -0.175 | 0.971 | 5.06 s | 0.18 s |
| Qwen casual | 0 / 71 | -0.161 | 0.977 | 4.72 s | 0.23 s |
| MiMo clear | 0 / 71 | -0.216 | 0.971 | 5.70 s | 0.26 s |

The sample is deliberately small, so these numbers are a release gate rather than a universal TTS
benchmark. They show that Qwen preserved every tested word while producing tighter delivery and
better ASR sequence confidence than the current free MiMo track. That is the relevant improvement
for sentence memorization. MiMo remains a temporary per-clip fallback until each Qwen batch lands.

## Reproducible runtime

The tested Mac runtime is pinned in `scripts/offline/requirements-qwen-tts.txt`. MLX 0.32.0 failed
to compile its Metal cache on this host, while MLX 0.31.2 generated and aligned clips successfully.
Generation uses `scripts/offline/generate-real-life-audio.py`; every accepted MP3 is 24 kHz mono,
loudness-normalized, content-addressed by voice and exact text, and accompanied by word timings.
The importer refuses a hash conflict under an existing voice version.
