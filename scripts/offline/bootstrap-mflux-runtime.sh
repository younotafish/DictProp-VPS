#!/usr/bin/env bash
set -euo pipefail

RUNTIME_ROOT="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/dictprop/mflux}"
SOURCE_COMMIT="${MFLUX_SOURCE_COMMIT:-97ac5e6280e8c65e48a609722229eb9d03ef2cbe}"
BASE_PYTHON="${BASE_PYTHON:-python3}"
PIP_TRUST=(--trusted-host pypi.org --trusted-host files.pythonhosted.org)

runtime_ready() {
  [[ -x "$RUNTIME_ROOT/bin/python" ]] && "$RUNTIME_ROOT/bin/python" - <<'PY' >/dev/null 2>&1
from PIL import Image
from mflux.models.common.config import ModelConfig
from mflux.models.ernie_image import ErnieImage
from mflux.models.krea2.variants.txt2img.krea2 import Krea2
PY
}

if runtime_ready; then
  printf 'Persistent MFLUX runtime is ready: %s\n' "$RUNTIME_ROOT"
  exit 0
fi

parent="$(dirname "$RUNTIME_ROOT")"
build_root="${RUNTIME_ROOT}.build-$$"
archive="$parent/mflux-$SOURCE_COMMIT.tar.gz"
previous="${RUNTIME_ROOT}.previous"
mkdir -p "$parent"
cleanup() { rm -rf "$build_root"; }
trap cleanup EXIT

"$BASE_PYTHON" -m venv "$build_root"
"$build_root/bin/python" -m pip install "${PIP_TRUST[@]}" \
  'mflux==0.18.0' 'uv==0.7.22' 'uv_build==0.7.22'
curl --fail --location --retry 3 \
  --output "$archive" \
  "https://github.com/filipstrand/mflux/archive/$SOURCE_COMMIT.tar.gz"
PATH="$build_root/bin:$PATH" "$build_root/bin/python" -m pip install \
  --no-deps --no-build-isolation --force-reinstall "$archive"

"$build_root/bin/python" - <<'PY'
from PIL import Image
from mflux.models.common.config import ModelConfig
from mflux.models.ernie_image import ErnieImage
from mflux.models.krea2.variants.txt2img.krea2 import Krea2
print(ModelConfig.ernie_image_turbo().model_name)
print(ModelConfig.krea2().model_name)
PY

rm -rf "$previous"
if [[ -e "$RUNTIME_ROOT" ]]; then mv "$RUNTIME_ROOT" "$previous"; fi
mv "$build_root" "$RUNTIME_ROOT"
rm -rf "$previous"
trap - EXIT
printf 'Installed persistent MFLUX runtime at %s from %s\n' "$RUNTIME_ROOT" "$SOURCE_COMMIT"
