#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Allow ROUTEKIT_SHELL_ROOT override (used in tests)
SHELL_ROOT="${ROUTEKIT_SHELL_ROOT:-"$SCRIPT_DIR/.."}"

SOURCE_DIR="$SHELL_ROOT/.claude/skills"
PROMPTS_DIR="$SHELL_ROOT/.rks/prompts"
REGISTRY="$SHELL_ROOT/projects/index.jsonl"
SOURCE_PROJECT_ID="routekit-shell"

# Skills to exclude from vendoring (project-specific)
EXCLUDE=("promote")

# NOTE: .rks/agents/ is intentionally NOT vendored.
# Agent definitions are project-specific — each project registers
# its own specialist agents (e.g. trading-ops for traders).
# Only skills and governor prompts are vendored from rks core.

if [ ! -d "$SOURCE_DIR" ]; then
  echo "ERROR: Source directory not found: $SOURCE_DIR" >&2
  exit 1
fi

# Read target project roots from the registry
read_registry_targets() {
  if [ ! -f "$REGISTRY" ]; then
    return
  fi
  node -e "
const fs = require('fs');
const lines = fs.readFileSync('${REGISTRY}', 'utf8').trim().split('\n').filter(Boolean);
for (const line of lines) {
  try { const r = JSON.parse(line); const root = r.root || r.path; if (root) console.log(root); } catch(e) {}
}
" 2>/dev/null || true
}

# Use arguments if provided, otherwise read registry
if [ $# -gt 0 ]; then
  TARGETS=("$@")
else
  TARGETS=()
  while IFS= read -r line; do
    [ -n "$line" ] && TARGETS+=("$line")
  done < <(read_registry_targets)
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
    echo "WARNING: Target not found, skipping: $target" >&2
    continue
  fi

  target_project_id="$(resolve_project_id "$target")"
  if [ -z "$target_project_id" ]; then
    echo "WARNING: Could not resolve projectId for $target, skipping" >&2
    continue
  fi

  target_skills="$target/.claude/skills"
  mkdir -p "$target_skills"

  copied=0
  skipped=()

  for skill_dir in "$SOURCE_DIR"/*/; do
    skill_name="$(basename "$skill_dir")"

    # Check exclusion list
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

    # Copy skill directory
    cp -R "${skill_dir%/}" "$target_skills/"

    # Substitute source projectId with target projectId in all copied SKILL.md files
    if [ "$target_project_id" != "$SOURCE_PROJECT_ID" ]; then
      find "$target_skills/$skill_name" -name "*.md" | while read -r f; do
        perl -pi -e "s/$SOURCE_PROJECT_ID/$target_project_id/g" "$f"
      done
    fi

    copied=$((copied + 1))
  done

  echo "$(basename "$target"): copied $copied skills to $target_skills/ (projectId: $target_project_id)"
  if [ ${#skipped[@]} -gt 0 ]; then
    echo "  skipped: ${skipped[*]}"
  fi

  # Copy Governor and Agent prompts
  if [ -d "$PROMPTS_DIR" ]; then
    target_prompts="$target/.rks/prompts"
    mkdir -p "$target_prompts"
    prompt_count=0
    for prompt_file in "$PROMPTS_DIR"/*.md; do
      [ -f "$prompt_file" ] || continue
      cp "$prompt_file" "$target_prompts/"
      prompt_count=$((prompt_count + 1))
    done
    echo "$(basename "$target"): copied $prompt_count prompts to $target_prompts/"
  fi
done
