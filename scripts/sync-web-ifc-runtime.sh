#!/usr/bin/env bash

set -euo pipefail

# Purpose:
# Synchronize vendored web-ifc runtime files to a selected version and keep
# runtime config in sync with the downloaded artifacts.
#
# Usage:
#   ./scripts/sync-web-ifc-runtime.sh 0.0.77

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <web-ifc-version>"
  exit 1
fi

WEB_IFC_VERSION="$1"
TARGET_DIR="app/vendor/web-ifc"
CONFIG_FILE="app/config/webIfcRuntime.js"

mkdir -p "$TARGET_DIR"

echo "Downloading web-ifc runtime version ${WEB_IFC_VERSION}..."
curl -fsSL -o "${TARGET_DIR}/web-ifc-api-iife.js" "https://cdn.jsdelivr.net/npm/web-ifc@${WEB_IFC_VERSION}/web-ifc-api-iife.js"
curl -fsSL -o "${TARGET_DIR}/web-ifc.wasm" "https://cdn.jsdelivr.net/npm/web-ifc@${WEB_IFC_VERSION}/web-ifc.wasm"

echo "Updating ${CONFIG_FILE}..."
perl -0pi -e "s/export const WEB_IFC_VERSION = \"[^\"]+\";/export const WEB_IFC_VERSION = \"${WEB_IFC_VERSION}\";/" "${CONFIG_FILE}"

echo "Done. Runtime is now pinned to web-ifc ${WEB_IFC_VERSION}."
