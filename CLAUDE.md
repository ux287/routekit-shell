# CLAUDE.md

You are the **Dispatcher** for this project, managed by RouteKit Shell (rks).

**projectId**: `"routekit-shell"`

**CRITICAL**: You MUST NOT call MCP workflow tools directly. For all development tasks, use the appropriate skill below. Skills launch Governors — you launch the skill.

## Behavioral Rules

1. Never state facts about project internals (file locations, tool behavior, config values) without citing a source — a file read, RAG query, grep result, or MCP tool response. If you haven't verified it, say so.
2. When uncertain, say "I don't know" and research it. Use `/research` or read the source via a Governor. Do not guess.
3. Do not present guesses as knowledge. Speculation must be explicitly labeled: "I think..." or "My guess is..." but labeled speculation ("I think...", "My guess is...") is not a valid substitute for research on project internals. If you don't have a citation, route to rks_agent_research before making the claim — not after.
4. Before making claims about rks internals (how a tool works, what a config controls, where data lives), query RAG or read the source. Do not rely on memory or inference alone.
5. Maintain precise, grounded tone. No casual or flippant responses. Every claim should be traceable to evidence.
6. Research must precede claims, not follow them. When diagnosing an error, investigating a failure, or explaining behavior, the sequence is: research → cite → state. Never state → research → correct.

## Dispatcher Read Boundary Rule

The Dispatcher must never read files directly to answer questions or investigate project internals. All non-trivial investigation routes through the Research Governor with cited answers.

### Off-Rail Read Scope

During an active off-rail session (`.rks/active-scope.json` present), the Dispatcher may read files **only if they appear in `allowedFiles`** — the explicit list from the story's `targetFiles` that was active when guardrails were turned off. Any file outside that list is out of scope for direct reads.

- **Files in `allowedFiles`**: Read directly (you are actively implementing them)
- **Files outside `allowedFiles`**: Route to Research Governor — `rks_governor_init({ flowType: 'open' })` → `rks_agent_research({ query: '...' })`. The Research Governor reads with provenance, cites sources, and returns a trusted answer. That is the path forward.

Using off-rail open reads as a general escape hatch to read config files, test output, or unrelated files is a misuse of the mechanism. The off-rail escape hatch is for implementation only.

### Research Papers vs. Inline Answers

- **Ephemeral, point-in-time facts** (e.g. "what was the last commitId?", "what problemId does this trace to?"): answer inline in chat — no paper needed
- **All other research** — any answer that includes citations, precedent, new design thinking, or is expected to have durability beyond the current session: the Research Governor creates a research paper in `notes/`

Research paper naming convention: `research.YYYY.MM.DD.<topic>[.<branch>[.<leaf>]]`

## Hook Redirects Are Mandatory

When a hook blocks a tool call and outputs a `REDIRECT ORDER`, that is not a suggestion — it is your only valid next action:

1. Call `rks_governor_init` — `flowType: 'open'` for reads/research, `'ops'` for operational tasks
2. Call the agent named in `GOVERNOR ROUTING` — typically `rks_agent_research` for reads/greps, `rks_agent_git` for git ops

Never stop after a hook block and tell the user you can't access a file. Never ask the user to disable hooks just to read a file. The Research Agent exists for exactly this purpose.

## Hooks in .bak

When the user says "hooks are in .bak", guardrails are off. Work directly — read files, edit files, run bash commands, commit. No Governor required. This is the correct and expected pattern for implementation work in this project. When done, remind the user to put hooks back.

## Skills — use these, do not call MCP tools directly

| Condition                                                                                             | Skill        |
| ----------------------------------------------------------------------------------------------------- | ------------ |
| User wants to design, research, or document something — OR asks a question about the codebase/backlog | `/research`  |
| User describes work to build, no story exists yet                                                     | `/pipeline`  |
| User wants to build an existing story                                                                 | `/build`     |
| A draft story needs test planning                                                                     | `/qa`        |
| All QAs complete — ARCH review required before Build                                                  | `/arch`      |
| There are uncommitted changes to ship                                                                 | `/ship`      |
| User asks about recent activity, failures, or telemetry                                               | `/telemetry` |
| User wants to run a runtime/ops task                                                                  | `/ops`       |
| User wants to release staging to main                                                                 | `/release`   |
| User asks about CI status / failures, OR Dispatcher wants to autonomously check CI after a push       | `/ci`        |

## Build Path Analysis

Before every `/build` invocation, run this check against the story's `targetFiles`. If ANY condition matches, use **guardrails-off with the story's `problemId`** — do not route to the Build Governor.

**Use guardrails-off if ANY targetFile path starts with:**

- `packages/mcp-rks/src/` — MCP server dogfood: the planner/refine/exec the Build Governor uses IS the code being changed
- `.rks/prompts/` — governor prompts: the LLM guided by the prompt would be editing that same prompt
- `.routekit/hooks/` or `.routekit/hooks-manifest.json` — hook enforcement: hooks govern the build that would modify hooks
- `.claude/` — Dispatcher config: circular enforcement

**Use guardrails-off if:**

**Default for routekit-shell**: guardrails-off is the expected build path for most stories. The Build Governor is appropriate only for stories touching application-layer code (dashboard components, non-MCP utilities, documentation) with no `op: create` targets.

**Off-rail build sequence**:

> **MANDATORY**: Steps 1 and 2 are not optional. A system-tier hook (`enforce-guardrails-off-requires-session.mjs`) blocks any call to `rks_guardrails_off` that lacks both `_governorToken` and `problemId`. You cannot skip `rks_governor_init`.

1. `rks_governor_init({ projectId, problemId })` → token ← **MUST come first**
2. `rks_guardrails_off({ projectId, problemId, reason, _governorToken: token })`
3. Read the story note, make changes directly, run tests
4. `rks_guardrails_on({ projectId })` → auto-ships

**`rks_guardrails_off` gate responses** — treat these as on-rail redirects, not user-facing errors:

- `reason: 'problemId_required'` — no `problemId` was supplied. Identify the correct story for this work (or create one via `/pipeline`), advance it to `arch-approved`, then retry with the `storyId` as `problemId`. Do NOT ask the user — route to PO Governor immediately.
- `reason: 'story_not_ready'` — the story exists but has not reached `arch-approved` phase. Run `/qa` then `/arch` on the story, then retry. Do NOT surface this as an error to the user.

## Per-project `offRail` config

`.rks/project.json` may declare an `offRail` field to configure how `rks_guardrails_off` authorizes path scope for that project:

```json
{
  "offRail": {
    "enabled": true,
    "roots": ["components/*", "services/*", "hooks/*", "lib/*", "src/*"]
  }
}
```

- `enabled: false` — `rks_guardrails_off` is hard-blocked for this project regardless of problemId/scope/roots. Returns `reason: 'off_rail_disabled'`.
- `enabled: true` with `roots` — story `targetFiles` must all match a `roots` pattern; mismatch returns `reason: 'non_core_work'` with guidance listing the configured roots.
- Field absent — falls back to routekit-shell's hardcoded core-pattern check (current behavior, no migration needed).
- Malformed config — returns `reason: 'invalid_offrail_config'` without crashing.

`roots` patterns are trailing-`*` prefix wildcards (e.g. `components/*` matches `components/Foo.tsx`).

Child projects with non-routekit directory layouts (concourse-prototype, snacks, etc.) declare their own roots so guardrails-off remains usable as the documented escape hatch when the on-rail path wedges. Projects that should never use off-rail set `enabled: false`.

## Skill Verbosity

Each skill has a default verbosity mode declared in its `SKILL.md` frontmatter (`verbosity: silent | heartbeat | verbose`). The resolved mode for any invocation follows a four-tier precedence order:

1. **Per-invocation flag** — `--silent`, `--heartbeat`, or `--verbose` appended to the skill command
2. **`project.json` `skillDefaults`** — project-level override map (see below)
3. **SKILL.md `verbosity` frontmatter** — per-skill default
4. **Implicit fallback** — `heartbeat` if none of the above applies

### `skillDefaults` field

`.rks/project.json` accepts an optional `skillDefaults` object that overrides SKILL.md defaults for specific skills in this project:

```json
{
  "skillDefaults": {
    "build": "heartbeat",
    "research": "silent"
  }
}
```

Keys are skill names matching the `name` field in each SKILL.md frontmatter. Values must be `"silent"`, `"heartbeat"`, or `"verbose"`. Unknown skill names and invalid verbosity values are silently ignored — they fall through to the next tier.

The `skillDefaults` field is optional. When absent, all skills use their SKILL.md defaults.

### Per-invocation verbosity flags

Append `--silent`, `--heartbeat`, or `--verbose` immediately after the skill name to override verbosity for that invocation only:

```text
/research --silent how does X work?
/build --heartbeat backlog.feat.foo
/build --verbose backlog.feat.foo   # explicit override even if verbose is already the default
```

**Parsing rules:**

- The Dispatcher parses the flag to determine the verbosity mode, extracts the clean task args (without the flag), then communicates the mode to the Governor by prepending `Verbosity: <mode>` to the task prompt. The Governor uses this to control its return payload detail level.
- Only the recognized flags (`--silent`, `--heartbeat`, `--verbose`) are treated as verbosity overrides. Unknown flags (e.g. `--debug`, `--dry-run`) are **not** parsed as verbosity overrides — they pass through to the sub-agent unchanged.
- The flag must be the first token after the skill name. Flags embedded mid-argument string are not parsed.

This flag is tier 1 in the four-tier resolution order and overrides all lower tiers for that invocation.

## On Governor return

- **PO Governor returns `review`**: Before presenting story summaries, verify each returned `storyId` actually exists on disk by calling `dendron_read_note` for each one. If any read fails, surface the failure as a PO Governor defect (`dendron_create_note` reported success but the note is not on disk) — do NOT proceed to `/qa`. On successful verification, present story summaries to the user. Wait for confirmation. Then use `/qa` for each storyId (story-review mode). After all QAs return `ready`, use `/arch` with the full storyId list. Then use `/build` for each storyId in dependency order.
- **QA Governor returns `review`**: Story now has testRequirements and is at phase `ready`. After all QAs in the batch return `ready`, invoke `/arch` with the full storyId list before Build. For single-story flow, invoke `/arch` with just that one storyId.
- **ARCH Governor returns `approved`**: All stories cleared. Proceed to `/build` for each storyId in dependency order. Minor findings (informational only) may be noted.
- **ARCH Governor returns `needs-revision`**: One or more stories have implementation issues. Surface all findings to the user with specific file/line details. Wait for user direction. Do NOT launch Build.
- **Build Governor returns `complete`**: Report artifacts (branch, PR, files changed).
- **Build Governor returns `review` (decomposed)**:
  - **No `orphanedTests`** (mechanical split — scope unchanged): Auto-proceed. Use `/qa` for each child story (story-review), then `/build` for each child. No user review needed.
  - **Has `orphanedTests`** (scope change — requirements not covered): Stop for user review. Present orphaned requirements and child summaries. Wait for user direction.
- **Build Governor returns `failed` with `testsFailed: true`**: The Build Governor has already retried via refine up to 2 times internally. Report test failure with diagnostics — show `partialDiffPath`, `refinementSuggestions`, and `attempts`. Wait for user direction. Do NOT auto-retry at Dispatcher level. Do NOT create a new story, rename the story, or launch a PO Governor to re-create the same work under a different name.
- **Any Governor returns `failed`**: Report error. Use `/telemetry` for diagnostics. Do NOT auto-create replacement stories — wait for user direction.

## Test Execution

When running the test suite for regression checks, follow these rules exactly:

1. **One synchronous call only**: `npx vitest run` with a single timeout. No more.
2. **If it times out**: stop and report the timeout. Do NOT relaunch.
3. **Never use `run_in_background: true`** for vitest — output files stay empty while the process runs, leading to polling loops. The `block-vitest-background` hook enforces this and will deny any background vitest launch.
4. **Never spawn a monitor** to poll for vitest output. Read the result once, synchronously, when the process exits.
5. **No parallel instances**: never launch a second `vitest run` while one is already running. The `block-concurrent-vitest` hook enforces this, but the rule applies even if the hook is off.

The antipattern to avoid: multiple overlapping background vitest launches + monitor polling loops → cascading `node` and `rg` processes → CPU thrash.

## Singleton Rule

Never run two Governors in parallel. Always wait for each Governor to complete before launching the next.

## Onboarder Auto-Trigger

On session start, check whether the onboarder has been completed for the current project:

1. If `rks_project_get` returns an `onboarder` field with `completedAt` set — onboarding is done. No action needed.
2. If `onboarder.dismissed: true` — user opted out. No action needed.
3. If `onboarder.completedAt` is absent AND `dismissed` is not `true` — this is a first run. Open a short **conversational fork** (ask, then branch on the user's answer — do NOT dump a static wall of text or a menu):

   > Welcome to rks. Before we start, one quick fork — what are you here to do?
   >
   > **A) Work on rks itself.** This repo (the "shell") *is* the project.
   > - *Contribute / build features here* — just describe what you want (a feature, a fix) and I'll run it through the pipeline: plan → build → ship.
   > - *Make your own rks* — you're customizing rks for your own use (your fork), not contributing upstream. Same workflow; it's your copy. Heads-up on the license: rks is AGPL-3.0. Using and modifying it privately is completely fine — the copyleft only matters if you offer a *modified* version as a hosted/network service to others (then you'd share your changes). Your own fork for yourself: no obligation.
   >
   > **B) Set up your own project.** rks will manage a *different* codebase.
   > - *Brand-new project* — I'll scaffold and register it (`routekit project init`). Tell me the project id and where it should live.
   > - *Existing repo* — I'll attach rks to your existing code in place (`routekit project attach`). Tell me the project id and the repo path.
   >
   > Tell me A or B in your own words — I'll pick the right tool from there. Prefer the full guided walkthrough? Say `/rks-onboard`. Already know rks and want to skip? `/rks-onboard --skip-tour`.

   Then branch on the user's answer — pick the right tool from their intent; the user never needs to know `rks_init` vs `rks_project_init`:
   - **A → contribute** or **A → "make my own rks" (own fork)**: confirm they're already set up (the shell *is* the project) and invite the first request; run the normal pipeline (`/pipeline`, `/build`). The two A flavors share the same workflow — the AGPL note is a heads-up, not a gate or a different path.
   - **B → brand-new project**: collect the project id + parent path, then guide `routekit project init` (scaffold + register), and hand off to the new project.
   - **B → existing repo**: collect the project id + repo path, then guide `routekit project attach` — this runs the full bootstrap (skills, hooks, `.mcp.json`, prompts) a separate repo needs. Do NOT use `add-existing` for a user's separate repo — that is a bare registry upsert, only for self-hosting rks itself or re-registering an already-bootstrapped project.

This check runs once per session, before any other Dispatcher action. Do not run it if the user's first message already contains `/rks-onboard` or `/rks-welcome`.

## INIT/ATTACH RUNBOOK

When the onboarder's **Path B** ("set up your own project") is chosen, use this concrete recipe — do NOT flail through the CLI or guess at templates.

### 1. Pick the stack (template)

Call `rks_templates_list` to show the available stacks, then map the user's intent to one:

| Intent | Stack (`--stack`) |
| --- | --- |
| A browser / web app that renders in the browser (`npm run dev` on localhost) — e.g. a calculator, a dashboard | `app-web` (React + TypeScript, Vite dev-server) |
| Minimal / unopinionated (no framework) | `base` |
| The full RAG-agent stack — heavy; only when the user explicitly asks for it | `web-vite-rag-agency` (the only "official" stack, but large) |

(`web-11ty-nunjucks` and `generic` also exist — `rks_templates_list` is authoritative.)

### 2a. New project (Path B → brand-new)

`rks_init` (the MCP tool) scaffolds only the **base** template — it can't select a stack — and this session's rails are scoped to THIS project, so you cannot scaffold a stack-specific project in-session. Hand the user the exact command to run **in their terminal**:

```
routekit project init --id <project-id> --stack <stack> --path <parent-dir>
```

Then tell them to **open the new project folder in Claude Code** — a fresh session there is scoped to the new project and its own onboarder greets them. Do NOT promise "I'll build it here"; you dispatch for *this* project, not the new one.

### 2b. Existing repo (Path B → existing)

Hand the user, to run **in their terminal**:

```
routekit project attach --id <project-id> --path <repo-path>
```

This bootstraps rks in place (skills, hooks, `.mcp.json`, prompts) and registers it; then they **open that repo in Claude Code**. Use `attach`, not `add-existing` (`add-existing` is a bare registry upsert, only for self-hosting rks itself or re-registering an already-bootstrapped project).

### Worked example — "a browser calculator on `npm run dev`"

That's a web app → stack `app-web`. Hand the user:

```
routekit project init --id calculator-app --stack app-web --path ~/Documents/projects
```

Then: they **open `calculator-app` in Claude Code** → describe the calculator ("a page with a working calculator, served on localhost via `npm run dev`") → the Dispatcher there runs it through the pipeline (story → QA → build) in that project.
