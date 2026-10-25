#!/bin/sh
# Copies the canonical theme and icon from shared-assets/ into each build
# (extensions can't load files from outside their own root).
set -e
cd "$(dirname "$0")"
for dir in chrome firefox carmen-extension-sharing; do
  cp shared-assets/theme.css "$dir/theme.css"
  cp shared-assets/icons/icon128.png "$dir/icon128.png"
done
