---
id: canon.getting-started
title: Getting Started
desc: >-
  Step-by-step guide: prerequisites, installation, project init, first story,
  and verifying a successful build
created: 1778386248000
updated: 1778386248000
---

This guide walks you through installing rks, initializing a project, and running your first story through the full build pipeline. For a conceptual overview of what rks is and why it exists, see [[canon.what-is-rks]]. For a deep dive on when to use the off-rail path vs. the standard Build Governor, see [[canon.build-path-analysis]].

## Prerequisites

Before you begin, make sure you have the following installed and configured:

- **Node.js 20+** — rks requires Node.js 20 or later. Check with `node --version`.
- **npm 10+** — comes bundled with Node.js 20. Check with `npm --version`.
- **Git** — required for branch management, commits, and the ship workflow. Check with `git --version`.
- **GitHub CLI (`gh`)** — required for PR creation and merge. Install from [cli.github.com](https://cli.github.com) and authenticate with `gh auth login`.
- **An Anthropic API key** — rks Governors and agents use Claude via the Anthropic API. Get a key at [console.anthropic.com](https://console.anthropic.com).

## Installation

Clone the routekit-shell-core repository and install dependencies:

```bash
git clone https://github.com/your-org/routekit-shell-core.git
cd routekit-shell-core
npm install
```

After `npm install` completes, all governor and agent prompts are present in `.rks/prompts/` — no additional setup is required for the shell project itself.

## Configure Project

Copy the environment template and fill in your credentials:

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

```bash
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...
```

The `.env.example` file documents every supported variable with inline comments. The two critical variables are `ANTHROPIC_API_KEY` (required for all Governor and agent invocations) and `GITHUB_TOKEN` (required for PR creation and merge in the ship workflow).

Do not commit `.env` — it is listed in `.gitignore`. Only `.env.example` is committed.

## Initialize Project

Once credentials are set, verify the project registry can locate this project:

```bash
npx rks project:get routekit-shell-core
```

If the project is not yet registered, initialize it:

```bash
npx rks init --projectId routekit-shell-core
```

This writes a `.rks/project.json` with your project's configuration: branch strategy, skill defaults, off-rail roots, and agent registry. After init, re-run `project:get` to confirm the project resolves correctly.

## First Story

rks development follows a four-phase pipeline: **PO → QA → ARCH → Build**. Each phase is a Governor that reads and writes backlog story notes. You drive the pipeline through skills — the Dispatcher routes each skill to the appropriate Governor.

### Create a story with /po

Use `/po` to describe work in plain language. The PO Governor turns your description into a structured backlog story with acceptance criteria, target files, and test requirements:

```text
/po Add a utility that formats duration milliseconds as human-readable strings (e.g. "2m 30s")
```

The PO Governor returns a story summary and a `storyId` (e.g. `backlog.feat.format-duration`). Review the summary and confirm before proceeding.

### Add test requirements with /qa

Use `/qa` to run the QA Governor on a draft story. QA adds `testRequirements` to the frontmatter and advances the story to `phase: ready`:

```text
/qa backlog.feat.format-duration
```

### Architecture review with /arch

Once QA completes, use `/arch` to run the ARCH gate. ARCH reviews the story's implementation plan for architectural soundness and either approves or returns findings:

```text
/arch backlog.feat.format-duration
```

If ARCH returns `approved`, proceed to Build. If it returns `needs-revision`, surface the findings to the team and address them before retrying.

### Build with /build

Once a story reaches `arch-approved`, use `/build` to implement it:

```text
/build backlog.feat.format-duration
```

The Build Governor creates a feature branch, implements the changes, runs the appropriate test tier, and opens a PR. When it returns `complete`, the PR is open and ready for review.

## Verify

After `/build` returns `complete`, verify the result:

1. **Check the PR** — `gh pr list` or `gh pr view` to see the open PR. Review the diff.
2. **Run unit tests locally** — confirm the test suite passes:

   ```bash
   npx vitest run --config vitest.config.unit.mjs
   ```

3. **Merge** — once the PR is approved, merge it. The ship workflow handles commit, PR, and merge automatically if you use `/ship`.

For details on how test tiers work and when each tier runs during a build, see [[canon.test-tiers]].

## Prompts and Agent Configuration

rks agents and governors load their system prompts from `.rks/prompts/`. After cloning routekit-shell and running `npm install`, all prompts are already present in `.rks/prompts/` — no additional setup is required for the shell project itself.

For a complete explanation of how prompts work, how to add new agent prompts, and how they distribute to child projects, see [[canon.prompt-architecture]].

## Child Project Setup

When you create a child project with `rks_init` or `attachProject()`, governor and agent prompts are automatically copied from `.rks/prompts/` into the new project. To push prompt updates to existing child projects, run:

```bash
ROUTEKIT_SHELL_ROOT=/path/to/routekit-shell-core bash scripts/vendor-skills.sh
```

## See Also

- [[canon.what-is-rks]] — Conceptual overview of the Governor model and pipeline phases
- [[canon.build-path-analysis]] — When to use the off-rail path vs. the standard Build Governor
- [[canon.test-tiers]] — The unit/mock/e2e test tiers, when each runs, and how to invoke them
- [[canon.prompt-architecture]] — Where prompts live, naming conventions, `loadAgentPrompt()` behavior, and distribution
- [[public.canon.rks-config]] — Configuration reference: `.mcp.json`, `.env`, project registry, branch strategy
