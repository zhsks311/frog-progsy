#!/bin/bash
set -euo pipefail

echo "Installing frogprogsy..."

# Check or install Bun
if ! command -v bun &>/dev/null; then
  echo "Bun not found. Installing..."
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"
fi

BUN_VER=$(bun --version)
echo "Using Bun v$BUN_VER"

# Install frogprogsy globally
bun install -g frogprogsy

echo ""
echo "✅ frogprogsy installed! Run 'frogp init' to set up."
