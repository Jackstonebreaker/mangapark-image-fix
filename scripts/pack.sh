#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/dist"
ZIP_NAME="mangapark-image-fix.zip"

mkdir -p "${OUT_DIR}"

# Files/folders to include in the extension package
INCLUDE=(
  "_locales"
  "icons"
  "content.js"
  "injected_patch.js"
  "manifest.json"
  "migrate.css"
  "migrate.html"
  "migrate.js"
  "migrate_utils.js"
  "mp_export_runner.js"
  "popup.html"
  "popup.js"
  "service_worker.js"
  "README.md"
  "PRIVACY.md"
  "LICENSE"
)

cd "${ROOT_DIR}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

for item in "${INCLUDE[@]}"; do
  if [[ -e "${item}" ]]; then
    cp -R "${item}" "${TMP_DIR}/"
  else
    echo "Missing item: ${item}" >&2
    exit 1
  fi
done

cd "${TMP_DIR}"
zip -r "${OUT_DIR}/${ZIP_NAME}" . >/dev/null

echo "OK: ${OUT_DIR}/${ZIP_NAME}"

