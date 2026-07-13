#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
cd "${REPO_ROOT}"

# Skip LLM calls for deterministic smoke tests
export RKS_SKIP_LLM=1
# Skip pre-flight checks (branch, clean, fresh) for smoke tests
export RKS_SKIP_PREFLIGHT=1
# Set project root so MCP server finds .rks/project.json without registry
export RKS_PROJECT_ROOT="${REPO_ROOT}"

validate_state() {
  local run_dir="$1"
  test -d "${run_dir}"
  test -f "${run_dir}/run.json"
  test -f "${run_dir}/plan.json"
  test -f "${run_dir}/plan.yaml"
  PLAN_PATH="${run_dir}/plan.json" node - <<'EOF'
const fs = require('fs');
const planPath = process.env.PLAN_PATH;
const data = JSON.parse(fs.readFileSync(planPath, 'utf8'));
if (!data.ragContextSummary) {
  console.error('planner smoke: plan.json missing ragContextSummary');
  process.exit(1);
}
if (typeof data.ragContextSummary.notesHitCount !== 'number') {
  console.error('planner smoke: ragContextSummary.notesHitCount must be a number');
  process.exit(1);
}
if (!data.slug) {
  console.error('planner smoke: plan.json missing slug');
  process.exit(1);
}
EOF
}

# Run analyze first (required before plan)
node packages/cli/bin/routekit.js analyze routekit-shell >/dev/null

json_out="$(node packages/cli/bin/routekit.js plan routekit-shell --label=smoke-ci 'Smoke planner input')"
run_folder="$(printf '%s' "${json_out}" | node -e "const fs=require('fs'); const text=fs.readFileSync(0,'utf8'); process.stdout.write(JSON.parse(text).runFolder);")"
validate_state "${run_folder}"

json_out="$(node packages/cli/bin/routekit.js plan routekit-shell --label=smoke-fs '${HOME} $(date +%s) ;; rm -rf / && printf "$(whoami)"')"
run_folder2="$(printf '%s' "${json_out}" | node -e "const fs=require('fs'); const text=fs.readFileSync(0,'utf8'); process.stdout.write(JSON.parse(text).runFolder);")"
validate_state "${run_folder2}"

# Check registry list (before cleanup)
list_output="$(node packages/cli/bin/routekit.js plan routekit-shell --list || true)"
# Use bash pattern matching to avoid SIGPIPE with grep -q
if [[ "${list_output}" != *"smoke-ci"* ]]; then
  echo "planner smoke: --list output missing smoke-ci"
  exit 1
fi

# Cleanup test runs
rm -rf "${run_folder}"
rm -rf "${run_folder2}"

# Ensure plan.yaml is generated with valid structure
sample_output="$(node packages/cli/bin/routekit.js plan routekit-shell --label smoke-todo 'Sample problem text')"
sample_run="$(printf '%s' "${sample_output}" | node -e "const fs=require('fs'); const text=fs.readFileSync(0,'utf8'); process.stdout.write(JSON.parse(text).runFolder);")"
if ! grep -q "^status:" "${sample_run}/plan.yaml"; then
  echo "planner smoke: plan.yaml missing status field"
  exit 1
fi
if ! grep -q "^steps:" "${sample_run}/plan.yaml"; then
  echo "planner smoke: plan.yaml missing steps field"
  exit 1
fi
rm -rf "${sample_run}"

# NOTE: Project init smoke tests skipped - CLI syntax changed significantly
# TODO: Update project smoke tests when project init command is stabilized

echo "planner smoke ok"
