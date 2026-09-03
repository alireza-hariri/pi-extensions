#!/usr/bin/env bash
# install.sh — install/update pi and this extensions repo
set -euo pipefail

EXT_DIR="${PI_EXTENSIONS_DIR:-$HOME/.pi/agent/extensions}"
REPO="https://github.com/alireza-hariri/pi-extentions.git"

echo "==> Installing/updating pi (global npm)..."
if npm ls -g @earendil-works/pi-coding-agent >/dev/null 2>&1; then
  echo "pi already installed — updating..."
  npm update -g @earendil-works/pi-coding-agent
else
  npm install -g @earendil-works/pi-coding-agent
fi

echo "==> pi version: $(pi --version 2>/dev/null || echo 'unknown')"

echo "==> Installing/updating extensions in $EXT_DIR..."
if [ -d "$EXT_DIR/.git" ]; then
  git -C "$EXT_DIR" pull --ff-only
else
  git clone "$REPO" "$EXT_DIR"
fi

if [ -f "$EXT_DIR/package.json" ]; then
  echo "==> Installing extension dependencies..."
  npm ci --prefix "$EXT_DIR" || npm install --prefix "$EXT_DIR"
fi

echo "==> Done. Restart pi to load any extension changes."
