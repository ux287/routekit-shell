#!/usr/bin/env bash
set -euo pipefail

find_project_codex_home() {
  local dir="$PWD"
  while true; do
    if [[ -f "$dir/.codex/config.toml" ]]; then
      echo "$dir"
      return 0
    fi
    if [[ "$dir" == "/" ]]; then
      return 1
    fi
    dir="$(dirname "$dir")"
  done
}

project_root="$(find_project_codex_home || true)"
if [[ -n "${project_root:-}" ]]; then
  export CODEX_HOME="$project_root/.codex"
  cd "$project_root"
fi

shim_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
path_no_shim="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v "^$shim_dir$" | paste -sd ':' -)"
real_codex="$(PATH="$path_no_shim" command -v codex || true)"

if [[ -n "${real_codex:-}" ]]; then
  exec "$real_codex" "$@"
fi

if command -v npx >/dev/null 2>&1; then
  if npx --help 2>/dev/null | grep -q -- '--yes'; then
    exec npx --yes @openai/codex "$@"
  fi
  exec npx -y @openai/codex "$@"
fi

if command -v npm >/dev/null 2>&1; then
  exec npm exec @openai/codex -- "$@"
fi

echo "Error: codex not found. Install @openai/codex or add it to PATH." >&2
exit 127
