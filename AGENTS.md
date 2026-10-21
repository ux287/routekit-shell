# AGENTS.md

RouteKit Shell (rks) — an MCP-powered development engine that orchestrates AI coding agents.

## Build & Test

```bash
npm test                          # run all tests
npm run build                     # build all packages
npm run lint                      # lint check
```

## Architecture

```
packages/mcp-rks/src/server.mjs   # MCP server — all tool definitions and handlers
packages/mcp-rks/src/server/      # Server modules (interview, refine, ship, planner, etc.)
packages/mcp-rks/src/agents/      # Agent wrappers (research, git, ship, dendron, etc.)
packages/mcp-rks/src/shared/      # Shared utilities (session-state, telemetry)
templates/base/                   # Base template scaffolded by rks_project_init
templates/generic/.routekit/hooks/ # Hook templates copied to child projects
.routekit/hooks/                  # Active hooks for this project (self-dev)
notes/                            # Dendron knowledge graph (stories, playbooks, prompts)
```

## Key Concepts

- **MCP tools** (`rks_plan`, `rks_exec`, `rks_ship`, `rks_refine`): server-side, no governor token needed
- **Agent wrappers** (`rks_agent_*`): require `_governorToken` from `rks_governor_init`
- **Stories**: `notes/backlog.*.md` with YAML frontmatter, structured `targetFiles: [{ path, op, desc }]`
- **Hooks**: `.routekit/hooks/*.mjs`, async `main()` pattern, fail-open (`exit 0` on error)

## Git Workflow

Branch from `staging`. PR into `staging`. `staging` → `main` for releases.
Branch naming: `feature/`, `fix/`, `refactor/`, `docs/`, `chore/`, `rks/`

## Conventions

- Commit style: `type(scope): message` (e.g., `feat(governor): thin Governor model`)
- Stories have max 4 acceptance criteria per story
- All hooks check `process.env.RKS_GUARDRAILS === "off"` for self-dev bypass
- MCP tool calls bypass PreToolUse hooks entirely
