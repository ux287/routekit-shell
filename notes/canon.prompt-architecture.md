---
id: mix3s8jaoyq9vzs9ssd8pfe
title: Prompt Architecture
desc: >-
  Reference: where prompts live in rks, naming conventions, how
  loadAgentPrompt() loads them, and how they distribute to child projects
updated: 1778386248000
created: 1778386248000
---

All rks prompts — both governor prompts and agent prompts — live in `.rks/prompts/`. This is the canonical location. No prompts should live in `notes/` or anywhere else in the project tree.

## Two Kinds of Prompts

**Governor prompts** are named `governor-{role}.md`. They are read by the LLM (the Dispatcher or Build Governor subagent) at the start of each session via a direct file read. They contain the system instructions that define how a Governor behaves: its tools, workflow, output format, and hard limits. Examples: `governor-po.md`, `governor-build.md`, `governor-qa.md`.

**Agent prompts** are named `agent-{name}.md`. They are loaded programmatically at runtime by `loadAgentPrompt()` in `packages/mcp-rks/src/agents/config.mjs` and injected into the `system` parameter when spawning a sub-agent via the Anthropic SDK. Examples: `agent-dendron.md`, `agent-research.md`, `agent-git.md`.

The distinction matters for distribution and loading, but the storage location is the same for both: `.rks/prompts/`.

## `loadAgentPrompt(agentName, projectRoot)`

`loadAgentPrompt()` is the only programmatic loader for agent prompts. Key behaviors:

- **Hot-reloaded on every call** — there is no caching. Every `loadAgentConfig()` call re-reads the file from disk. This means you can edit a prompt file and the next agent invocation picks up the change immediately without restarting the MCP server.
- **Strips YAML frontmatter** — if the file starts with `---` frontmatter, the body after the closing `---` is returned. Raw body files (no frontmatter) are returned as-is.
- **Null-fallback** — if the file does not exist at `.rks/prompts/agent-{name}.md`, `loadAgentPrompt()` returns `null`. When the prompt is `null`, the agent runner uses its inline hardcoded default prompt (defined in the agent runner file). This null-fallback is intentional — it allows agents to function in child projects where a custom prompt has not been configured yet.

Example: loading the dendron agent prompt for `projectRoot = /path/to/project` reads from `/path/to/project/.rks/prompts/agent-dendron.md`.

## Naming Conventions

| Type | Pattern | Example |
|------|---------|---------|
| Governor prompt | `governor-{role}.md` | `governor-build.md` |
| Agent prompt | `agent-{name}.md` | `agent-dendron.md` |

Agent names match the string passed to `loadAgentPrompt()`, which matches the keys in `packages/mcp-rks/src/agents/config.mjs`'s `DEFAULTS` map: `dendron`, `research`, `git`, `ship`, `story`, `delivery`, `recovery`, `planner`, `cycle-complete`, etc.

## How to Add a New Agent Prompt

1. Create `.rks/prompts/agent-{name}.md` with the prompt body (frontmatter is optional).
2. The prompt is picked up automatically on the next agent invocation — no code change required.
3. If the agent is new (not yet in `DEFAULTS`), add it to the `DEFAULTS` map in `packages/mcp-rks/src/agents/config.mjs` to set its model, `maxTurns`, and `timeoutMs`.
4. Distribute to child projects (see below).

## Distribution to Child Projects

Prompts must be distributed when routekit-shell is updated, because child projects depend on the prompts from their parent shell.

**For existing child projects — `vendor-skills.sh`:**

`scripts/vendor-skills.sh` copies all `*.md` files from `.rks/prompts/` to each registered child project's `.rks/prompts/` directory. It reads the project registry at `projects/index.jsonl` and distributes to every project whose `root` path exists on disk. Run it manually after adding or updating any prompt file:

```bash
ROUTEKIT_SHELL_ROOT=/path/to/routekit-shell-core bash scripts/vendor-skills.sh
```

**For new child projects — `attachProject()`:**

When a new child project is initialized via `rks_init` or `attachProject()`, `ensureGovernorArtifacts()` in `packages/cli/src/project/bootstrap.mjs` copies all `governor-*.md` and `agent-*.md` files from `.rks/prompts/` into the new project's `.rks/prompts/` directory. This runs automatically — no manual step required.

## Why `.rks/prompts/` and Not `notes/`

Earlier versions stored agent prompts in the `notes/` directory alongside Dendron documentation. This was an accident of the initial implementation: Dendron was conceived as the knowledge graph for all project data, and prompts were stored there as a side effect. Governor prompts were later separated into `.rks/prompts/` because they needed to be distributed to child projects, but agent prompts were not moved at the same time.

The canonical design is that `notes/` is for human-readable documentation, backlog stories, and research papers — content that belongs in a knowledge graph. `.rks/prompts/` is for machine-consumed configuration that the MCP server reads at runtime. Mixing these had the practical consequence that `vendor-skills.sh` only copied governor prompts, leaving child projects without agent prompts until the distribution mechanism was fixed.

All prompts now live in `.rks/prompts/`.

## See Also

- [[canon.getting-started]] — Installation, first project, and build workflow
- [[public.canon.build-path-analysis]] — When and why to use the off-rail build path
- `packages/mcp-rks/src/agents/config.mjs` — `loadAgentPrompt()` and `loadAgentConfig()` implementation
- `scripts/vendor-skills.sh` — Distribution script for existing child projects
- `packages/cli/src/project/bootstrap.mjs` — `ensureGovernorArtifacts()` for new child project init
