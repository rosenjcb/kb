#!/bin/zsh
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.kb-python"

python3 -m venv "$VENV_DIR"
"$VENV_DIR/bin/python3" -m pip install --upgrade pip
"$VENV_DIR/bin/python3" -m pip install -r "$ROOT_DIR/requirements/fact-category-clustering.txt"
