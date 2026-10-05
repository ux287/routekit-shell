---
id: v6xvinqmsm7swxfj7u0zv9g
title: Rks Config
desc: >-
  Complete reference for all config files that govern how rks boots and runs,
  plus the minimal setup path for new users.
updated: 1778123000945
created: 1777857261603
---

# rks Configuration Reference

> Authoritative reference for all configuration files that govern rks. For conceptual background see [[public.canon.what-is-rks]]. For installation walkthrough see [[public.canon.getting-started]].

---

## Overview

rks is configured through five layers of files. Each layer has a distinct scope and owner:

| File                    | Scope                                         | Who edits it                |
| ----------------------- | --------------------------------------------- | --------------------------- |
| `.mcp.json`             | Project — declares MCP servers to Claude Code | Developer (once, on clone)  |
| `.claude/settings.json` | Project — env vars, permissions, hooks        | rks (auto-managed)          |
| `.rks/project.json`     | Project — rks metadata (RAG, notes, branches) | rks (auto-managed)          |
| `.env`                  | Local — secrets and API keys                  | Developer (never committed) |
| `.routekit/`            | Project — hooks and guardrails runtime        | rks (auto-managed)          |

---

## `.mcp.json` — MCP Server Declaration

**Location:** project root  
**Format:** JSON, `mcpServers` object

`.mcp.json` tells Claude Code which MCP servers to start when the project is open. It is the entry point for everything rks does.

### Current structure (routekit-shell)

```json
{
  "mcpServers": {
    "rks-gov": {
      "command": "node",
      "args": ["scripts/mcp/governance-server.mjs"],
      "env": {}
    },
    "rks": {
      "command": "node",
      "args": ["packages/mcp-rks/bin/mcp-rks.mjs"],
      "env": {
        "ROUTEKIT_PROJECT_ROOT": "/absolute/path/to/routekit-shell"
      }
    },
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp",
      "headers": {
        "Authorization": "Bearer <github-token>"
      }
    }
  }
}
```

### The two rks servers

| Server key | Entry point                         | Purpose                                                                                                                                                          |
| ---------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rks`      | `packages/mcp-rks/bin/mcp-rks.mjs`  | Main workflow tools — Governors, agents, RAG, Dendron, git ops, guardrails                                                                                       |
| `rks-gov`  | `scripts/mcp/governance-server.mjs` | Quality-gate tools — `gov_test_run`, `gov_lint_check`, `gov_build_check`, `gov_scope_validate`, `gov_quality_check`, `gov_regression_check`, `gov_release_check` |

### `ROUTEKIT_PROJECT_ROOT`

**Optional override.** The MCP server automatically derives the project root from its own install location (`packages/mcp-rks/bin/` → three levels up). `ROUTEKIT_PROJECT_ROOT` is only consulted if it is set to a non-empty value in the `env` block — it then loads `.env` from that path first, before falling back to the derived root. Most users will never need to set this. It exists for non-standard layouts where the MCP binary is installed outside the project tree.

### Why servers show "Disabled" in the Claude Code IDE

Claude Code has a two-tier MCP config hierarchy:

1. **Global** — `~/.claude.json`, per-project-path entries
2. **Local** — `.mcp.json` / `.claude/settings.json` in the project

The global file takes strict precedence. If `~/.claude.json` contains an entry for the project path with an empty `mcpServers: {}`, Claude Code interprets that as "this project has zero servers" — not "defer to local config." The result is all servers showing as **Disabled** even though `.mcp.json` is correct.

**Fix:** ensure `~/.claude.json` either has no entry for the project path, or has the full server definitions copied in. `rks_init` (when run with `dev=true`) writes MCP config to both locations to prevent this.

### Can `.mcp.json` be shipped pre-configured?

Yes, fully. `.mcp.json` is checked into the repo with no machine-specific values. The server derives its project root automatically — no path editing required after cloning. A new user's only setup steps are `npm install` and copying `.env`.

---

## `.claude/settings.json` — Claude Code Project Settings

**Location:** `.claude/settings.json`  
**Managed by:** rks (hooks auto-registered; env vars set during init)

This file configures the Claude Code harness for this project. rks writes and owns it — do not edit manually unless directed.

### What it contains

**`env`** — environment variables injected into every Claude Code session:
- `ENABLE_TOOL_SEARCH: "true"` — activates deferred tool schema loading
- `RKS_GUARDRAILS: "on"` — default guardrails state (overridden at runtime by `rks_guardrails_off`)

**`permissions`** — tool allow/deny lists:
- `allow` — pre-approved tools that skip confirmation prompts (e.g. `mcp__rks__rks_guardrails_on`)
- `deny` — blocked reads/writes matching secret file patterns (`.env*`, `*.pem`, `*.key`, `.ssh/**`, etc.)

**`hooks`** — `PreToolUse` and `PostToolUse` hook registrations pointing into `.routekit/hooks/`. These are the enforcement layer for guardrails, RAG provenance, git workflow rules, and telemetry tracking.

### Relationship to `.mcp.json`

`.mcp.json` declares *which servers to start*. `.claude/settings.json` controls *what Claude Code does once they're running* — env vars, permissions, and behavioral hooks. They are complementary, not redundant.

---

## `.rks/project.json` — rks Project Metadata

**Location:** `.rks/project.json`  
**Managed by:** rks (`rks_init` creates it; never edit manually)

Core project identity and infrastructure paths. Schema version 1.

### Fields

| Section    | Field                     | Purpose                                                   |
| ---------- | ------------------------- | --------------------------------------------------------- |
| Identity   | `id`                      | Project identifier (e.g. `"routekit-shell"`)              |
| Identity   | `root`                    | Absolute path to project root                             |
| Identity   | `schemaVersion`           | Always `1`                                                |
| Notes      | `vaultPath`               | Dendron notes directory (default: `"notes"`)              |
| Notes      | `dendronConfig`           | Path to `dendron.yml`                                     |
| RAG        | `indexPath`               | Vector index path (default: `"routekit/rag/index.lance"`) |
| RAG        | `enabled`                 | Whether RAG is active (default: `true`)                   |
| KG         | `configPath`              | Knowledge graph config YAML                               |
| LLM        | `providerEnvVar`          | Env var name for provider selection                       |
| LLM        | `supportedProviders`      | Allowed providers (`["openai", "anthropic", "google"]`)   |
| Branches   | `branches.working`        | Feature branch prefix                                     |
| Branches   | `branches.integration`    | Integration branch (e.g. `"staging"`)                     |
| Branches   | `branches.production`     | Production branch (e.g. `"main"`)                         |
| Timestamps | `createdAt` / `updatedAt` | ISO timestamps                                            |
| Skills     | `skillDefaults`           | Object mapping skill name → verbosity (`"silent"`, `"heartbeat"`, or `"verbose"`); overrides SKILL.md defaults project-wide. Example: `{ "build": "heartbeat", "research": "silent" }` |
| OffRail    | `offRail.enabled`         | Boolean. `true` enables guardrails-off sessions; `false` hard-blocks `rks_guardrails_off` for this project (returns `reason: off_rail_disabled`). |
| OffRail    | `offRail.roots`           | Array of trailing-wildcard prefix patterns (e.g. `["src/*", "components/*"]`). Story `targetFiles` must all match at least one root. Files outside all roots return `reason: non_core_work`. Only evaluated when `offRail.enabled` is `true`. |

### Branch config and 3-branch detection

rks detects 3-branch workflow when `branches.working !== branches.integration`. The `getBranchConfig()` function in `packages/mcp-rks/src/server/project.mjs` requires both the project record and this JSON to be passed — missing `projectJson` is a known source of branch detection bugs.

---

## `.env` — Secrets and API Keys

**Location:** project root  
**Never committed.** Copy from `.env.example`.

### Required

| Variable                | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`     | Powers all Governors (required if using Anthropic)                       |
| `ROUTEKIT_LLM_PROVIDER` | Provider selection: `"anthropic"` or `"openai"` (default: `"anthropic"`) |
| `ROUTEKIT_LLM_MODEL`    | Model identifier (default: `"claude-sonnet-4-6"`)                        |

### Optional but commonly needed

| Variable               | Purpose                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `GITHUB_TOKEN`         | PR creation, CI status polling, GitHub MCP server            |
| `BRAVE_SEARCH_API_KEY` | Web search in Research Agent (`rks_agent_external_research`) |
| `OPENAI_API_KEY`       | Required if `ROUTEKIT_LLM_PROVIDER=openai`                   |

**Note:** `ROUTEKIT_PROJECT_ROOT` is set in `.mcp.json`'s `env` block — not in `.env`. The MCP server loads `.env` using the path from `ROUTEKIT_PROJECT_ROOT`.

---

## `.routekit/` — Hooks and Guardrails Runtime

**Location:** `.routekit/`  
**Managed by:** rks

| Path                  | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `hooks/`              | Active hook `.mjs` files, organized by tier                    |
| `hooks.bak/`          | Temporary home for hooks moved out during `rks_guardrails_off` |
| `hooks-manifest.json` | Tier classification: `write`, `read`, `system`                 |

### Hook tiers

- **write** — blocks/redirects code modifications; disabled during off-rail sessions
- **read** — enforces provenance, RAG discovery, context checks; stays active during off-rail sessions
- **system** — infrastructure: guardrails gate, auto-enable, RAG embed on commit; never disabled individually

### Guardrails state

Tracked in `.rks/guardrails-state.json` (not in `.routekit/`). Active scope tracked in `.rks/active-scope.json`. Session log at `.rks/guardrails-off-sessions.jsonl`.

---

## Minimal Setup for a New User

After cloning the routekit-shell repo, a new user needs five steps:

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env`

```bash
cp .env.example .env
# Edit .env and add ANTHROPIC_API_KEY (required)
# Add GITHUB_TOKEN if you need PR/CI features
```

### 3. Update `.mcp.json`

Open `.mcp.json` and update `ROUTEKIT_PROJECT_ROOT` in the `rks` server's `env` block to the absolute path of your clone:

```json
"env": {
  "ROUTEKIT_PROJECT_ROOT": "/your/actual/path/to/routekit-shell"
}
```

This is the only machine-specific change needed. All other values in `.mcp.json` are correct as shipped.

### 4. Fix `~/.claude.json` if servers show "Disabled"

If the Claude Code IDE shows rks servers as Disabled:

```bash
# Check if the global file has a conflicting empty entry
cat ~/.claude.json | grep -A5 "routekit-shell"
```

If you see `"mcpServers": {}` for your project path, either remove that entry or copy the full server definitions from `.mcp.json` into `~/.claude.json` under the project path key.

### 5. Run the onboarder

Open the project in Claude Code and run:

```
/onboard
```

The onboarder runs `rks_init` to create `.rks/project.json`, initializes RAG, and guides through the first story.

### What you do NOT need to configure manually

- `.claude/settings.json` — managed by rks, already checked in
- `.rks/project.json` — created by `rks_init` during onboarding
- `.routekit/hooks/` — already in the repo, no user action needed
- `rks-gov` server path — works as shipped (relative path, no absolute path needed)

---

## Can the Repo Ship MCP Pre-Configured?

Partially yes. The `.mcp.json` file is already in the repo with correct server definitions. The only blocker to fully zero-config MCP is `ROUTEKIT_PROJECT_ROOT` — it must be an absolute path to the user's clone location.

Two approaches to reduce friction:

1. **Current approach (shipped):** User edits one line in `.mcp.json` after clone.
2. **Future approach (not yet implemented):** Use a setup script or `rks_init` to auto-detect and write `ROUTEKIT_PROJECT_ROOT` into `.mcp.json` as part of first-run.

The `~/.claude.json` global override issue means that even with a perfect `.mcp.json`, users on machines that previously had a different rks install may see Disabled servers. `rks_init --dev` writes to both files to prevent this, but requires running inside Claude Code first — a bootstrap catch-22 for brand-new users.

---

## Cross-References

- [[public.canon.what-is-rks]] — what rks is and why it exists
- [[public.canon.getting-started]] — step-by-step installation walkthrough
- [[public.canon.build-path-analysis]] — when to use guardrails-off vs on-rail build
