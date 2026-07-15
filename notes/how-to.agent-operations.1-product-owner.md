---
id: how-to.agent-operations.1-product-owner-tasks
title: 1 Product Owner
desc: >-
  How the PO Governor writes stories — chain, research, RAG, namespaces,
  decomposition
updated: 1772208896825
created: 1772207196456
---

## Purpose

Create backlog stories from task descriptions. The PO Governor produces **story notes with structured frontmatter** — it never calls `rks_plan`, `rks_exec`, or `rks_refine`.

Called by the Dispatcher when the user describes work without an existing backlog story. The Dispatcher launches the PO Governor via `Task(subagent_type: "general-purpose")`.

## Governor Chain

```
0. rks_governor_init({ projectId }) → TOKEN
1. rks_agent_research({ projectId, query, _governorToken: TOKEN })
1b. (OPTIONAL) rks_agent_external_research({ projectId, query, _governorToken: TOKEN })
1c. (OPTIONAL) Delegate to Research Governor for deep research → produces research.* note
2. dendron_create_note({ projectId, filename: 'backlog.feat.<slug>', title, desc, content, _governorToken: TOKEN })
3. dendron_update_field({ projectId, filename, field: 'targetFiles', value: [...], _governorToken: TOKEN })
4. dendron_update_field({ projectId, filename, field: 'testRequirements', value: [...], _governorToken: TOKEN })
5. rks_rag_embed({ projectId, files: ['notes/backlog.feat.<slug>.md'] })
6. dendron_update_field({ projectId, filename, field: 'phase', value: 'ready', _governorToken: TOKEN })
```

Repeats steps 2-6 for multi-story decomposition.

## Research Integration

### Direct Research (Step 1)
- Calls `rks_agent_research` to find relevant source files and current implementation
- Research output informs: real file paths for targetFiles, grounded requirements for ACs, accurate descriptions
- Grants provenance for the file paths the PO will reference

### External Research (Step 1b)
- Optional — "use your judgement, reach for it when codebase research alone isn't enough"
- Searches the web via Brave Search API
- Does not embed or create notes — returns synthesized answer only

### Delegated Deep Research (Step 1c)
- When a story requires deep architectural understanding or competitive analysis, PO should delegate to a **Research Governor**
- The Research Governor produces a `research.*` note and embeds it into RAG
- PO can then reference that research in the story's Problem/Solution sections
- This is the "agentified" flow — PO orchestrates research as a sub-task rather than doing shallow research itself

> **TODO**: The current PO Governor prompt does not include step 1c (Research Governor delegation). The prompt needs updating to describe when and how to delegate. The Dispatcher would need to launch a Research Governor first, wait for its return, then launch the PO Governor with the research note reference.

## Story Format

Body sections: `## Problem` / `## Solution` / `## Acceptance Criteria` / `## Target Files`

### Target Files (frontmatter)
Array of objects: `{ path, op: 'create'|'edit', desc }`
- Every new file MUST have `op: 'create'`
- Every existing file MUST have `op: 'edit'`

### Target Files (body)
Human-readable prose:
```markdown
## Target Files
- `src/components/Calculator.tsx` — CREATE FILE — Main calculator component
- `package.json` — EDIT — Add dependencies
```

### Acceptance Criteria
Checkboxes in body:
```markdown
## Acceptance Criteria
- [ ] Calculator renders with number buttons 0-9
- [ ] Clear button resets the display
```

### Test Requirements (frontmatter)
String array of verifiable outcomes:
```json
["Calculator renders number buttons", "Clear button resets display"]
```

## RAG Embedding

The PO Governor **explicitly calls `rks_rag_embed`** in step 5 to ensure the story is embedded before setting phase to 'ready'. This is an atomic operation — if embedding fails, the PO should handle the error and not proceed to phase='ready'.

- `rks_rag_embed` is unprotected (no Governor token needed)
- Must emit telemetry so we know who, when, and why
- `dendron_create_note` also triggers a background auto-embed, but the explicit call is the authoritative mechanism
- Embedding before phase='ready' ensures the story is discoverable by Build Governor research

## Allowed Namespaces

PO writes to **`backlog.feat.*`** for new features.

QA (when formalized) will own the `backlog.fix.*` namespace for bug stories. This gives clear ownership: PO = features, QA = bugs.

## Provenance Model

| Who | Gets provenance? | How |
|-----|------------------|-----|
| PO Governor | Yes | Its own `rks_agent_research` call in step 1 populates session state |
| Dispatcher | Yes (indirect) | Session state persists after PO returns; Dispatcher can read files PO's research identified |
| Build Governor | **Separate session** | Build calls its own `rks_governor_init` and starts fresh. Does NOT inherit PO provenance. Build runs its own research. |
| Research Governor (delegated) | Separate Governor session | If PO delegates to Research, that's a separate Governor with its own token. Research note persists in RAG for Build to discover later. |

## Decomposition

When a task naturally decomposes into multiple stories:
- PO repeats steps 2-6 for each child story
- Stories are listed in dependency order (build first → build last)
- Return format: `{ status: 'review', summary, artifacts: { stories: [{ storyId, notePath }] } }`

### AC Gate (.02-gate)
The planner rejects stories with >4 acceptance criteria. When this happens, the `.03-decompose` handler should split the story into smaller stories (each with ≤4 ACs) and return child storyIds for sequential build.

> **KNOWN GAP**: `.03-decompose` has not been built yet. Until it is, the .02-gate rejection has no automated recovery path. The PO Governor should proactively scope stories to ≤4 ACs.

## Governor Token and State Machine

- PO operates in **open flow** (no problemId on governor_init)
- Allowed tools (OPEN_FLOW_TOOLS): `rks_agent_research`, `rks_agent_external_research`, `rks_agent_git`, `rks_agent_visual`, `dendron_create_note`, `dendron_edit_note`, `dendron_read_note`, `dendron_update_field`, `rks_preflight`
- Explicitly forbidden: `rks_refine`, `rks_plan`, `rks_exec` (those belong to Build Governor)

## Bootstrapping

The Dispatcher launches the PO Governor as a `Task(subagent_type: "general-purpose")`. The Task subagent runs in Claude Code and IS subject to hooks. However, the Governor's chain is entirely MCP tools (`rks_governor_init`, `rks_agent_research`, `dendron_create_note`, etc.) which execute **server-side** and bypass hooks. The Governor prompt explicitly says "Never use Claude Code tools" — this is by design.

## Dispatcher Integration

Per CLAUDE.md, the Dispatcher:
1. Tells the Governor to read its own prompt at `.rks/prompts/governor-po.md`
2. Replaces `__PROJECT_ID__` with the project ID
3. Launches via `Task(subagent_type: "general-purpose", max_turns: 10)`

On return:
- `status: 'review'` → present story summaries to user, wait for confirmation, then launch Build Governor for each storyId in dependency order
- `status: 'failed'` → report error, suggest telemetry diagnostics