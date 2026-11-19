#!/usr/bin/env bash
# Build the standard configuration and put it where a shell finds it:
#   ~/.local/bin/ma
#   ~/.local/share/modular-agent/sidecars/claude   (the Claude Provider)
# Nothing else is touched. Run from anywhere.
set -euo pipefail

rust="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo="$(dirname "$rust")"
bin="${HOME}/.local/bin"
share="${HOME}/.local/share/modular-agent/sidecars"
export TMPDIR="${TMPDIR:-$HOME/.cache/ma-std-tmp}"
mkdir -p "$TMPDIR" "$bin" "$share"

echo "Building ma (release)..."
(cd "$rust" && mise exec -- cargo build --release --locked -p standard)
install -m 0755 "$rust/target/release/ma" "$bin/ma"
echo "Installed $bin/ma"

if command -v node >/dev/null 2>&1; then
  echo "Building the Claude sidecar..."
  (cd "$repo/sidecars/claude" && npm install --ignore-scripts --no-audit --no-fund && npm run build)
  # A link, so the sidecar keeps its node_modules and follows this checkout.
  ln -sfn "$repo/sidecars/claude" "$share/claude"
  echo "Linked $share/claude -> $repo/sidecars/claude"
else
  echo "node was not found: skipping the Claude sidecar. ChatGPT and Grok still work."
fi

case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "Note: $bin is not on your PATH." ;;
esac
echo "Next: ma login openai-codex | xai | claude, then ma auth"
