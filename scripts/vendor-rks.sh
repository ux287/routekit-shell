#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/../.claude/skills"
PROMPTS_DIR="$SCRIPT_DIR/../.rks/prompts"
HOOKS_DIR="$SCRIPT_DIR/../.routekit/hooks"
SETTINGS_FILE="$SCRIPT_DIR/../.claude/settings.json"
SOURCE_PROJECT_ID="routekit-shell"

# Skills to exclude from vendoring (project-specific)
EXCLUDE=("promote")

# Default target projects
DEFAULT_TARGETS=(
  "$SCRIPT_DIR/../../snacks-11ty-netlify"
  "$SCRIPT_DIR/../../aar/concourse-prototype"
)

if [ ! -d "$SOURCE_DIR" ]; then
  echo "ERROR: Source skills directory not found: $SOURCE_DIR" >&2
  exit 1
fi

# Use arguments if provided, otherwise defaults
if [ $# -gt 0 ]; then
  TARGETS=("$@")
else
  TARGETS=("${DEFAULT_TARGETS[@]}")
fi

# Resolve target projectId from .rks/project.json or CLAUDE.md
resolve_project_id() {
  local target="$1"
  local proj_json="$target/.rks/project.json"
  if [ -f "$proj_json" ]; then
    local id
    id=$(node -e "try { const p=require('$proj_json'); console.log(p.projectId||p.id||''); } catch(e){}" 2>/dev/null || true)
    if [ -n "$id" ]; then
      echo "$id"
      return
    fi
  fi
  local claude_md="$target/CLAUDE.md"
  if [ -f "$claude_md" ]; then
    local id
    id=$(grep -m1 'projectId' "$claude_md" | sed 's/.*"\(.*\)".*/\1/' | tr -d '[:space:]' || true)
    if [ -n "$id" ]; then
      echo "$id"
      return
    fi
  fi
  echo ""
}

for target in "${TARGETS[@]}"; do
  if [ ! -d "$target" ]; then
    echo "WARNING: Target not found, skipping: $target"
    continue
  fi

  target_project_id="$(resolve_project_id "$target")"
  if [ -z "$target_project_id" ]; then
    echo "WARNING: Could not resolve projectId for $target, skipping"
    continue
  fi

  echo "--- $(basename "$target") (projectId: $target_project_id) ---"

  # 1. Copy skills
  target_skills="$target/.claude/skills"
  mkdir -p "$target_skills"
  copied=0
  skipped=()
  for skill_dir in "$SOURCE_DIR"/*/; do
    skill_name="$(basename "$skill_dir")"
    skip=false
    for exc in "${EXCLUDE[@]}"; do
      if [ "$skill_name" = "$exc" ]; then
        skip=true
        skipped+=("$skill_name")
        break
      fi
    done
    if [ "$skip" = true ]; then
      continue
    fi
    cp -R "${skill_dir%/}" "$target_skills/"
    if [ "$target_project_id" != "$SOURCE_PROJECT_ID" ]; then
      find "$target_skills/$skill_name" -name "*.md" | while read -r f; do
        sed -i.bak "s/$SOURCE_PROJECT_ID/$target_project_id/g" "$f" && rm -f "${f}.bak"
      done
    fi
    copied=$((copied + 1))
  done
  echo "  skills: $copied copied to $target_skills/"
  if [ ${#skipped[@]} -gt 0 ]; then
    echo "  skills skipped: ${skipped[*]}"
  fi

  # 2. Copy governor prompts
  if [ -d "$PROMPTS_DIR" ]; then
    target_prompts="$target/.rks/prompts"
    mkdir -p "$target_prompts"
    prompt_count=0
    for prompt_file in "$PROMPTS_DIR"/governor-*.md; do
      [ -f "$prompt_file" ] || continue
      cp "$prompt_file" "$target_prompts/"
      prompt_count=$((prompt_count + 1))
    done
    echo "  prompts: $prompt_count copied to $target_prompts/"
  fi

  # 3. Copy hooks
  if [ -d "$HOOKS_DIR" ]; then
    target_hooks="$target/.routekit/hooks"
    mkdir -p "$target_hooks"
    hook_count=0
    for hook_file in "$HOOKS_DIR"/*.mjs; do
      [ -f "$hook_file" ] || continue
      cp "$hook_file" "$target_hooks/"
      hook_count=$((hook_count + 1))
    done
    echo "  hooks: $hook_count copied to $target_hooks/"
  fi

  # 4. Copy settings.json (hook configuration)
  if [ -f "$SETTINGS_FILE" ]; then
    target_claude_dir="$target/.claude"
    mkdir -p "$target_claude_dir"
    cp "$SETTINGS_FILE" "$target_claude_dir/settings.json"
    echo "  settings.json: copied to $target_claude_dir/"
  fi

  # 5. Copy vitest runner scripts — required for rks exec test runs
  VITEST_RUNNER="$SCRIPT_DIR/../scripts/vitest-runner.mjs"
  SPAWN_MANAGED="$SCRIPT_DIR/../scripts/lib/spawn-managed.mjs"
  if [ -f "$VITEST_RUNNER" ]; then
    mkdir -p "$target/scripts/lib"
    cp "$VITEST_RUNNER" "$target/scripts/vitest-runner.mjs"
    if [ -f "$SPAWN_MANAGED" ]; then
      cp "$SPAWN_MANAGED" "$target/scripts/lib/spawn-managed.mjs"
    fi
    echo "  vitest-runner: copied to $target/scripts/"
  fi

  # 6. Copy vitest.config.unit.mjs shim — no-overwrite (child may have customized)
  VITEST_SHIM="$SCRIPT_DIR/../templates/base/vitest.config.unit.mjs"
  VITEST_SHIM_DEST="$target/vitest.config.unit.mjs"
  if [ -f "$VITEST_SHIM" ] && [ ! -f "$VITEST_SHIM_DEST" ]; then
    cp "$VITEST_SHIM" "$VITEST_SHIM_DEST"
    echo "  vitest.config.unit.mjs: copied shim to $target/"
  fi

  # 7. Copy vitest.config.base.mjs — the config the shim re-exports — no-overwrite
  #    (single-sourced from templates/base/; child may have customized)
  VITEST_BASE="$SCRIPT_DIR/../templates/base/vitest.config.base.mjs"
  VITEST_BASE_DEST="$target/vitest.config.base.mjs"
  if [ -f "$VITEST_BASE" ] && [ ! -f "$VITEST_BASE_DEST" ]; then
    cp "$VITEST_BASE" "$VITEST_BASE_DEST"
    echo "  vitest.config.base.mjs: copied to $target/"
  fi

done
