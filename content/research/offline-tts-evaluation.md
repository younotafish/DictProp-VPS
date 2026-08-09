# Offline TTS evaluation

Evaluated on 2026-08-08 for the Real Life sentence catalog. The production target is locally
generated speech that can be imported into the VPS cache in small, resumable batches. The VPS does
not run the model.

## Status

The earlier decision to treat Qwen/Aiden as a quality replacement for MiMo is **withdrawn pending
perceptual testing**. Do not generate another bulk wave with these voice versions solely on the
strength of the ASR benchmark below. The currently imported recipes are:

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

The sample is deliberately small, and these measurements establish intelligibility only. They do
**not** measure native-likeness, connected-speech fluency, rhythm, stress, voice preference, or
whether a listener would choose the clip for memorization. The original interpretation overstated
what the evidence supported.

## Connected-speech finding

An audit of all 720 imported Qwen sentences found that the two recipes are not perceptually distinct
enough to support their labels. Casual averages 194 WPM versus 186 WPM for Clear, while positive
inter-word gaps and long-pause distributions are nearly identical. The app also plays cached clips
at a legacy default of 1.1×, inherited from the slower MiMo track. That raises the effective means to
roughly 214 and 204 WPM without creating more natural linkage.

This release changes only the untouched default to 1.0× so cached speech plays at its authored
rate. A listener's explicitly saved playback-rate preference is preserved.

The setup has three plausible quality problems that require a controlled listening test:

- Aiden is described as clear, and the long prompts further emphasize articulation and exact word
  preservation; that may encourage read-aloud delivery instead of conversational phrasing.
- Production sampling (`temperature` 0.72/0.82, `top_k` 35, `top_p` 0.92, repetition penalty 1.08)
  is narrower than Qwen's published defaults (0.9, 50, 1.0, 1.05).
- The 8-bit MLX conversion and the Aiden voice were never perceptually compared with bf16, Ryan,
  concise prompting, or MiMo under matched playback conditions.

`generate-qwen-naturalness-benchmark.py` and `generate-mimo-naturalness-benchmark.mjs` render a
five-sentence connected-speech set for blinded human ranking. A new immutable voice token and bulk
generation are required if a different voice, model precision, prompt, sampling recipe, or playback
rate wins.

## Reproducible runtime

The tested Mac runtime is pinned in `scripts/offline/requirements-qwen-tts.txt`. MLX 0.32.0 failed
to compile its Metal cache on this host, while MLX 0.31.2 generated and aligned clips successfully.
Generation uses `scripts/offline/generate-real-life-audio.py`; every accepted MP3 is 24 kHz mono,
loudness-normalized, content-addressed by voice and exact text, and accompanied by word timings.
The importer refuses a hash conflict under an existing voice version.
