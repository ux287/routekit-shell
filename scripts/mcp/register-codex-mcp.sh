#!/usr/bin/env bash
set -euo pipefail

# --- resolve repo root (two levels up from this script), even if called via symlink ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO="$(cd "$SCRIPT_DIR/../.." && pwd -P)"

echo "Registering RouteKit MCP servers with Codex"
echo "  repo: $REPO"

# --- ensure Node exists (required by your stdio servers) ---
if ! command -v node >/dev/null 2>&1; then
  echo "Error: 'node' not found on PATH. Install Node.js and retry." >&2
  exit 127
fi

# --- pick a Codex client: global 'codex' binary, otherwise fall back to npx / npm exec ---
declare -a CODEX
if command -v codex >/dev/null 2>&1; then
  CODEX=(codex)
elif command -v npx >/dev/null 2>&1; then
  # Prefer --yes when available; fallback to -y for older npx.
  if npx --help 2>/dev/null | grep -q -- '--yes'; then
    CODEX=(npx --yes @openai/codex)
  else
    CODEX=(npx -y @openai/codex)
  fi
elif command -v npm >/dev/null 2>&1; then
  # npm exec is slower but avoids global installs
  CODEX=(npm exec @openai/codex --)
else
  echo "Error: need Codex CLI or npx/npm on PATH. Try: npm i -g @openai/codex" >&2
  exit 127
fi

# --- verify server entrypoints exist (fail early if not) ---
RAG="$REPO/scripts/mcp/rag-server.mjs"
DENDRON="$REPO/scripts/mcp/dendron-server.mjs"
GOV="$REPO/scripts/mcp/governance-server.mjs"

for f in "$RAG" "$DENDRON" "$GOV"; do
  if [[ ! -f "$f" ]]; then
    echo "Error: missing server file: $f" >&2
    exit 1
  fi
done

# --- helper to (re)register a server idempotently ---
register() {
  local name="$1"; shift
  printf "• %-34s " "$name"

  # best-effort remove (ignore if not present)
  if "${CODEX[@]}" mcp remove "$name" >/dev/null 2>&1; then
    : # removed
  fi

  # add with an explicit WORKSPACE env pointing at the repo root
  "${CODEX[@]}" mcp add "$name" --env WORKSPACE="$REPO" -- "$@"

  echo "OK"
}

echo "Using Codex client: ${CODEX[*]}"
echo "Adding STDIO servers…"

# All servers launched via 'env node' to avoid hardcoding a node path.
register routekit-rag-routekit-shell        /usr/bin/env node "$RAG"
register routekit-dendron-routekit-shell    /usr/bin/env node "$DENDRON"
register routekit-governance-routekit-shell /usr/bin/env node "$GOV"

echo
echo "Done. Verify in Codex:"
echo "  1) VS Code → ChatGPT Codex → gear → MCP settings → Open config.toml"
echo "  2) Or run: ${CODEX[*]} mcp list"
echo "  3) Sanity check a server with: npx @modelcontextprotocol/inspector -- /usr/bin/env node \"$RAG\""