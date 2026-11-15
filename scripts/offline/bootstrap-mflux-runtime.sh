#!/usr/bin/env bash
# Installs the local MFLUX runtime the image stages render with, unless it is ready already: a venv with
# mflux 0.18.0 from PyPI, then mflux at SOURCE_COMMIT from GitHub's archive of it, which must hash to
# SOURCE_SHA256. The image stages can read the bridge key and the GitHub CLI's credentials, so nothing is
# installed unverified.
#
# pip checks certificates. Should a TLS-inspecting proxy make it fail, give pip the system's roots instead
# of turning the check off:
#   security find-certificate -a -p /Library/Keychains/System.keychain \
#     /System/Library/Keychains/SystemRootCertificates.keychain > "$TMPDIR/ca.pem"
#   PIP_CERT="$TMPDIR/ca.pem" scripts/offline/bootstrap-mflux-runtime.sh
set -euo pipefail

RUNTIME_ROOT="${1:-${XDG_CACHE_HOME:-$HOME/.cache}/dictprop/mflux}"
SOURCE_COMMIT="${MFLUX_SOURCE_COMMIT:-97ac5e6280e8c65e48a609722229eb9d03ef2cbe}"
# The SHA-256 of GitHub's archive of SOURCE_COMMIT; to install another commit, give both.
SOURCE_SHA256="${MFLUX_SOURCE_SHA256:-47dcc6a9a28d9b961f74e21022d8a7b2515968b63226a4e7fe8d9420e3a44fa1}"
BASE_PYTHON="${BASE_PYTHON:-python3}"

sha256_of() {
  if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1
}

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
archive="${build_root}.tar.gz"
previous="${RUNTIME_ROOT}.previous"
mkdir -p "$parent"
cleanup() { rm -rf "$build_root" "$archive"; }
trap cleanup EXIT

"$BASE_PYTHON" -m venv "$build_root"
"$build_root/bin/python" -m pip install \
  'mflux==0.18.0' 'uv==0.7.22' 'uv_build==0.7.22'
curl --fail --location --retry 3 \
  --output "$archive" \
  "https://github.com/filipstrand/mflux/archive/$SOURCE_COMMIT.tar.gz"
if [ "$(sha256_of "$archive")" != "$SOURCE_SHA256" ]; then
  echo "The mflux archive of $SOURCE_COMMIT does not have the SHA-256 $SOURCE_SHA256; installing nothing" >&2
  exit 1
fi
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
printf 'Installed persistent MFLUX runtime at %s from %s\n' "$RUNTIME_ROOT" "$SOURCE_COMMIT"
