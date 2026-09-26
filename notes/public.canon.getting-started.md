---
id: o1fv17o3s62t1820w08lvmc
title: Getting Started
desc: >-
  Step-by-step guide: prerequisites, installation, project init, first story,
  and verifying a successful build
updated: 1778123000952
created: 1777848001000
---

**rks (RouteKit Shell)** is an AI-native development workflow system that wraps Claude Code with structured governance — every code change flows through defined stories, automated tests, and gated pipeline phases before shipping. This guide walks you through installing rks, configuring your first project, and running your first story end-to-end. It assumes familiarity with git and Claude Code but no prior rks experience. For a conceptual overview of why rks exists and how it works, see [[public.canon.what-is-rks]].

## 1. Prerequisites

Before installing rks you need:

- **Claude Code CLI** — installed and authenticated (`claude --version` works)
- **Node.js 20+** — rks uses ESM modules; Node 18 is not supported
- **Git** — standard install; a GitHub remote is needed for PR/CI features
- **GitHub CLI** (`gh`) — for automatic PR creation; install from [cli.github.com](https://cli.github.com) and run `gh auth login`

## 2. Installation

rks runs as an MCP server inside Claude Code. There is no global package to install.

**Step 1 — Clone or copy the rks source:**

```bash
git clone https://github.com/ux287/routekit-shell-core.git
cd routekit-shell-core
npm install
```

**Step 2 — Verify MCP is connected:**

Open a Claude Code session and run `/mcp`. You should see `rks` listed as a connected server with its tools available.

The repo ships with `.mcp.json` already configured — no path editing required. The MCP server derives its project root automatically from its own install location.

> **If MCP servers show "Disabled":** Claude Code's global config (`~/.claude.json`) can override local `.mcp.json` when it contains an entry for the project path with an empty server list. If rks tools are unavailable, remove that project path entry from `~/.claude.json` and restart Claude Code. See [[public.canon.rks-config]] for details.

## 3. Configure Your Environment

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

```
ANTHROPIC_API_KEY=sk-ant-...        # required
GITHUB_TOKEN=ghp_...                # required for PR creation
ROUTEKIT_LLM_MODEL=claude-sonnet-4-6
```

The `.env.example` file documents all available variables with inline comments explaining each one. Never commit `.env` — it is in `.gitignore`.

## 4. Meet the Onboarder

The `.rks/project.json` file already ships with the repo — no manual project initialization step required for clone-and-go users. The project is pre-configured with the correct `projectId`, branch strategy, and notes directory for this repository.

What happens instead is a guided onboarding tour. On your first session start, the Dispatcher auto-checks whether onboarding has been completed. If it has not, you will see a prompt like this:

> "Welcome to this rks project. It looks like the guided onboarding hasn't been completed yet. Run `/rks-onboard` to get a ten-minute walkthrough of stories, permissions, cost visibility, and a real first PR — or type `/rks-onboard --skip-tour` if you already know rks and just want the quick reference."

The onboarder (`rks_onboarder` tool) runs a 7-stage guided tour:

1. **welcome** — what rks is and what the session will cover
2. **expectations** — what the Governor workflow automates and what stays manual
3. **stance** — how the Dispatcher behaves (grounded, no guessing, hook compliance)
4. **first_story** — creating your first story with `/po`
5. **first_build** — running `/qa` and `/build` on that story
6. **first_ship** — reviewing the PR and merging with `/ship`
7. **next_steps** — further reading and recommended next stories

When the tour completes, `onboarder.completedAt` is recorded in your project record and the auto-check is silenced for all future sessions. You can also run `/rks-onboard --skip-tour` to set this flag immediately without going through the tour if you are already familiar with rks.

**After the onboarder completes**, you land in a live project session with all rks tools available. The Dispatcher is active, hooks are on, and the backlog is empty. Your next action is typically `/po` to describe your first real story, which kicks off the full PO → QA → ARCH → Build pipeline. The story the onboarder walked you through during `first_build` was a real build — its PR was merged into `staging` as part of the tour. You are now ready to work on production stories.

The onboarder check is the only thing that runs before your first Dispatcher action in a new session. It does not block you from issuing other commands.

## 5. Create and Build Your First Story

You can simply chat with Claude Code to see it hooked into using the skills. For instance:

> Build a simple caluclator app. Render it in a React web app that I can run on `http://localhost`.

Under the hood, Claude Code is hooked and begins working through a set of skills:

Use the skill commands to drive the pipeline:

**Create a story with `/po`:**

```
/po Add a hello-world endpoint to the API that returns { message: "hello" }
```

The PO Governor creates a story note in `notes/backlog.feat.<slug>.md` with scoped acceptance criteria and target files. Review the output and confirm.

**Add test requirements with `/qa`:**

```
/qa backlog.feat.<slug>
```

The QA Governor reviews the story and adds `testRequirements` to the frontmatter. It advances the story to `phase: ready`.

**Review the architecture with `/arch`:**

```
/arch backlog.feat.<slug>
```

The ARCH Governor runs a mechanical 8-item checklist against the story's target files and implementation plan. It returns `approved` (safe to build) or `needs-revision` (with specific file/line findings you must address before building). ARCH is mandatory — do not proceed to `/build` until it clears.

**Run the build with `/build`:**

```
/build backlog.feat.<slug>
```

The Build Governor implements the changes, runs the test suite, and auto-ships via PR when tests pass. For stories touching core rks files (`packages/mcp-rks/src/`, `.rks/prompts/`, `.routekit/hooks/`), see [[public.canon.build-path-analysis]] for the off-rail path.

## 6. How Shipping Works

You do not manage git manually. When the build completes and tests pass, shipping is automatic:

1. rks creates an `off-rail/<session-id>` branch from your current working branch
2. Your changes are committed to that branch with a structured commit message
3. A PR is opened against `staging` (or your configured integration branch)
4. The PR is merged automatically
5. The branch is cleaned up and you are returned to `staging`

The PR URL is reported in the build output. If CI is wired up, tests run on the PR before merge. If CI is not configured, merge happens immediately after the commit passes local tests.

If anything fails mid-ship (push error, CI failure, merge conflict), rks reports the step that failed and leaves the branch in place so you can recover manually. Run `/ship` to retry an incomplete ship, or check `/telemetry` to diagnose the failure.

## 7. Verify the Build Succeeded

When the Build Governor returns `complete`, check:

1. **PR is open** — The Governor reports a PR URL. Open it in your browser and review the diff.
2. **Tests pass** — CI should be green on the PR. If CI is not wired up, run tests locally:
   ```bash
   node scripts/vitest-runner.mjs --config vitest.config.unit.mjs
   ```
3. **Story phase updated** — The story note's `phase` field should now be `integrated` (after merge) or `building` (before merge).

If the build fails, the Build Governor reports `failed` with `testsFailed: true`, a `partialDiffPath`, and `refinementSuggestions`. Read the refinement suggestions, make any necessary adjustments to the story's acceptance criteria or target files, then retry with `/build`. The Build Governor will not auto-retry after a test failure — it waits for your direction so you can correct the story definition before spending more compute.

## 8. Cost Visibility

rks tracks token usage for every Governor session. When a build ships, the PR body includes a cost block showing the tokens consumed and estimated cost for that session — giving you a permanent per-story audit trail of AI spend.

To see a cost summary at any point during a session, use the telemetry skill:

```text
/telemetry
```

Or query directly with the `rks_token_cost_report` tool if you need raw token data outside a skill invocation.

Cost reporting covers all Governors invoked in the session: PO, QA, ARCH, and Build each log their own token usage. Complex stories with multiple refinement cycles will show higher counts.

## Where to Go Next

- [[public.canon.what-is-rks]] — Conceptual overview: the problem rks solves, the Governor model, and how the pipeline phases work
- [[public.canon.rks-config]] — Configuration reference: `.mcp.json`, `.env`, project registry, branch strategy, and `offRail` settings
- [[how-to.rks]] — Practical how-to guides for common tasks, troubleshooting ship failures, and tips for working with the off-rail path
