---
id: "how-to.child-project-kickoff"
title: "Child Project Kickoff Checklist"
desc: "Manual steps required to configure a new child project after rks_init scaffolding"
updated: 1777574106040
created: 1769531681655
---

# Child Project Kickoff Checklist

Reference checklist for configuring a new RKS child project after running `rks_init`.

## Which path are you on?

On a fresh setup the Dispatcher asks this conversationally (see the Onboarder Auto-Trigger in `CLAUDE.md`) — this is the same fork, written out:

- **Work on rks itself** — the shell repo *is* the project. Nothing to scaffold; just start chatting and run the pipeline. (Whether you're contributing upstream or building your own fork, the workflow is identical; rks is AGPL-3.0 — private use/modification is fine, the copyleft only bites if you offer a *modified* hosted service.)
- **Work on your own project** — rks manages a *different* codebase. Two sub-cases:
  - **Brand-new project** → `routekit project init` (or `rks_init` from chat): scaffolds from a template **and** bootstraps rks (skills, hooks, `.mcp.json`, prompts) + registers it.
  - **Existing repo** → `routekit project attach`: bootstraps rks **in place** in your existing code + registers it.

`rks_init` vs `rks_project_init`: `rks_init` creates a **new** project directory (scaffold). `rks_project_init` initializes rks inside the **current** project. `routekit project add-existing` is a registry-only upsert (no bootstrap) — reserved for self-hosting rks itself or re-registering an already-bootstrapped project, **not** a first-time attach of your own repo. When onboarding conversationally you don't need to remember any of this — the Dispatcher picks the right tool from your answer. The rest of this checklist covers the manual `rks_init` (new child project) path.

## Prerequisites

From the RKS project (routekit-shell), run:

```
rks_init { projectName: "<your-project>", dev: true }
```

This creates `../<your-project>/` with:
- Base template scaffolding
- `package.json` with `"@routekit/mcp-rks": "file:../routekit-shell/packages/mcp-rks"`
- Git initialized with `main` and `staging` branches (on staging)
- `routekit/project.json` identifying the project

## Terminal Setup (in child project directory)

### 1. Navigate to child project
```bash
cd ../<your-project>
```

### 2. Install dependencies
```bash
npm install
```

### 3. Configure environment
```bash
cp .env.example .env
```

Edit `.env` and add your provider credentials:
```
ANTHROPIC_API_KEY=sk-ant-...
# Or copy from routekit-shell/.env if using same keys
```

### 4. Register MCP server

**If `dev: true` was used** — skip this step. The `.mcp.json` already points to the local routekit-shell MCP server. Do NOT run `claude mcp add` (it creates a conflicting entry pointing to `node_modules/` which doesn't exist in dev mode).

**If `dev: false` (production/published package):**
```bash
claude mcp add rks -- node node_modules/@routekit/mcp-rks/bin/mcp-rks.mjs
```

### 4b. Clean the tree and config remote

```bash

git init
git add .
git commit -m "initial commit"
gh repo create <your-project> --private --source=. --remote=origin --push
git checkout -b staging
git push origin staging
```

## Claude Code Chat Setup (in child project)

Open Claude Code in the child project directory, then run these commands in chat:

### 5. Initialize RAG index
```
rks_rag_init { projectId: "<your-project>" }
```

### 6. Embed initial content
```
rks_rag_embed { projectId: "<your-project>" }
```

### 7. Verify setup
```
rks_preflight { projectId: "<your-project>" }
```

This should return child project context (not RKS context). Verify:
- Project ID matches your project name
- RAG index exists
- No blocking errors

### 8. Start development workflow
```
/rks-onboard
```

This kicks off the guided project setup process. For new users, `/rks-onboard` runs an interactive tour through the first story end-to-end. Skip with `/rks-onboard --skip-tour` if you've been through it before.

## Troubleshooting

### MCP server not found
- **Dev mode**: Verify `.mcp.json` exists at project root and points to `routekit-shell/packages/mcp-rks/bin/mcp-rks.mjs`. Do NOT use `claude mcp add` — it conflicts.
- **Published mode**: Verify `npm install` completed and `node_modules/@routekit/mcp-rks/bin/mcp-rks.mjs` exists. Re-run `claude mcp add` if needed.
- If `/mcp status` shows rks failed, check for conflicting entries: `claude mcp remove rks` then restart.

### RAG queries return RKS content instead of child project
- Verify you're in the child project directory when starting Claude Code
- Check that `routekit/project.json` exists in the child project
- The project root is detected by finding `routekit/project.json` walking up from cwd

### Environment variables not loaded
- Ensure `.env` exists in child project root
- Verify `ANTHROPIC_API_KEY` is set correctly
- Restart Claude Code after adding `.env`

## Quick Reference

| Step | Location    | Command                                                                     |
| ---- | ----------- | --------------------------------------------------------------------------- |
| 0    | RKS Chat    | `rks_init { projectName: "<your-project>", dev: true }`                     |
| 1    | Terminal    | `cd ../<your-project>`                                                      |
| 2    | Terminal    | `npm install`                                                               |
| 3    | Terminal    | `cp .env.example .env` + edit                                               |
| 4    | Terminal    | `claude mcp add rks -- node node_modules/@routekit/mcp-rks/bin/mcp-rks.mjs` |
| 5    | Claude Chat | `rks_rag_init { projectId: "<your-project>" }`                              |
| 6    | Claude Chat | `rks_rag_embed { projectId: "<your-project>" }`                             |
| 7    | Claude Chat | `rks_preflight { projectId: "<your-project>" }`                             |
| 8    | Claude Chat | `/rks-onboard`                                                                  |
