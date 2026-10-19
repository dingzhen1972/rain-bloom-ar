#!/usr/bin/env bash
# Downloads MediaPipe Tasks Vision (JS + WASM) and the face landmarker model into the repo,
# so the app does not depend on jsDelivr / Google Storage at runtime (useful in mainland China).
# Run locally once and commit the files, or let the Pages workflow run it on every deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
V=0.10.14
mkdir -p vendor/tasks-vision/wasm models

download() {
  local dest="$1"
  shift
  local tmp="${dest}.tmp"
  rm -f "$tmp"
  for url in "$@"; do
    echo "Downloading $dest from $url"
    if curl -fL --retry 3 --retry-delay 2 --retry-all-errors \
      --connect-timeout 20 --max-time 180 "$url" -o "$tmp"; then
      test -s "$tmp"
      mv "$tmp" "$dest"
      return 0
    fi
    rm -f "$tmp"
  done
  echo "Failed to download $dest from every configured mirror" >&2
  return 1
}

download vendor/tasks-vision/vision_bundle.mjs \
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$V/vision_bundle.mjs" \
  "https://fastly.jsdelivr.net/npm/@mediapipe/tasks-vision@$V/vision_bundle.mjs" \
  "https://unpkg.com/@mediapipe/tasks-vision@$V/vision_bundle.mjs"
for f in vision_wasm_internal.js vision_wasm_internal.wasm vision_wasm_nosimd_internal.js vision_wasm_nosimd_internal.wasm; do
  download "vendor/tasks-vision/wasm/$f" \
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@$V/wasm/$f" \
    "https://fastly.jsdelivr.net/npm/@mediapipe/tasks-vision@$V/wasm/$f" \
    "https://unpkg.com/@mediapipe/tasks-vision@$V/wasm/$f"
done
download models/face_landmarker.task \
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task"
download models/selfie_segmenter.tflite \
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite"
ls -la vendor/tasks-vision vendor/tasks-vision/wasm models
